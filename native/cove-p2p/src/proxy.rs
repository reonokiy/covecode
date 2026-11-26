use std::{convert::Infallible, io, time::Duration};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::{
    Request, Response, StatusCode, Uri, body::Incoming, client::conn, header, server::conn::http1,
    service::service_fn, upgrade,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::{
    net::TcpStream,
    sync::{mpsc, oneshot, watch},
    time::timeout,
};
use tokio_util::compat::FuturesAsyncReadCompatExt;

use super::Open;

type Body = BoxBody<Bytes, hyper::Error>;

fn empty(status: StatusCode) -> Response<Body> {
    let mut response = Response::new(
        Full::new(Bytes::new())
            .map_err(|never| match never {})
            .boxed(),
    );
    *response.status_mut() = status;
    response
}

fn destination(uri: &Uri, prefix: &str) -> Option<Uri> {
    if uri.authority().is_some() || uri.scheme().is_some() {
        return None;
    }
    let path = uri.path_and_query()?.as_str().strip_prefix(prefix)?;
    if !path.starts_with('/') || path.starts_with("//") {
        return None;
    }
    path.parse().ok()
}

async fn forward(
    mut request: Request<Incoming>,
    tx: mpsc::Sender<Open>,
    authority: String,
    prefix: String,
    mut lifetime: watch::Receiver<()>,
) -> Result<Response<Body>, io::Error> {
    if request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        != Some(authority.as_str())
    {
        return Ok(empty(StatusCode::FORBIDDEN));
    }
    let Some(uri) = destination(request.uri(), &prefix) else {
        return Ok(empty(StatusCode::NOT_FOUND));
    };
    *request.uri_mut() = uri;
    for name in [
        "forwarded",
        "x-forwarded-host",
        "x-forwarded-for",
        "x-forwarded-proto",
        "proxy-authorization",
    ] {
        request.headers_mut().remove(name);
    }
    let (reply, rx) = oneshot::channel();
    tx.try_send(reply).map_err(io::Error::other)?;
    let stream = rx.await.map_err(io::Error::other)??;
    let (mut sender, connection) = conn::http1::handshake(TokioIo::new(stream.compat()))
        .await
        .map_err(io::Error::other)?;
    let mut connection_lifetime = lifetime.clone();
    tokio::spawn(async move {
        tokio::select! { _ = connection.with_upgrades() => {}, _ = connection_lifetime.changed() => {} }
    });
    let upgrade_requested = request
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|h| h.as_bytes().eq_ignore_ascii_case(b"websocket"));
    let downstream = upgrade_requested.then(|| upgrade::on(&mut request));
    let mut response = sender
        .send_request(request)
        .await
        .map_err(io::Error::other)?;
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let Some(downstream) = downstream else {
            return Ok(empty(StatusCode::BAD_GATEWAY));
        };
        let upstream = upgrade::on(&mut response);
        tokio::spawn(async move {
            let pump = async {
                let (client, env) =
                    tokio::try_join!(downstream, upstream).map_err(io::Error::other)?;
                tokio::io::copy_bidirectional(&mut TokioIo::new(client), &mut TokioIo::new(env))
                    .await
            };
            tokio::select! { _ = pump => {}, _ = lifetime.changed() => {} }
        });
    }
    Ok(response.map(BodyExt::boxed))
}

pub(super) async fn serve(
    socket: TcpStream,
    tx: mpsc::Sender<Open>,
    authority: String,
    prefix: String,
    lifetime: watch::Receiver<()>,
) {
    let service = service_fn(move |request| {
        let request = forward(
            request,
            tx.clone(),
            authority.clone(),
            prefix.clone(),
            lifetime.clone(),
        );
        async move {
            let response = match timeout(Duration::from_secs(90), request).await {
                Ok(Ok(response)) => response,
                _ => empty(StatusCode::BAD_GATEWAY),
            };
            Ok::<_, Infallible>(response)
        }
    });
    let _ = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(5))
        .serve_connection(TokioIo::new(socket), service)
        .with_upgrades()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_capability_before_forwarding_http_and_upgrade_paths() {
        let prefix = "/.cove-tunnel/secret";
        for path in [
            "/ws",
            "/.cove-tunnel/secret2/ws",
            "/.cove-tunnel/secret//other/",
            "http://other/.cove-tunnel/secret/ws",
        ] {
            assert_eq!(destination(&path.parse().unwrap(), prefix), None);
        }
        assert_eq!(
            destination(&"/.cove-tunnel/secret/ws?ticket=t".parse().unwrap(), prefix).unwrap(),
            "/ws?ticket=t"
        );
    }
}
