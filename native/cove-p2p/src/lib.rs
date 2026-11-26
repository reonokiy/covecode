mod bridge;
mod proxy;
mod streams;
#[cfg(test)]
mod tests;

use futures::StreamExt;
use libp2p::{
    Multiaddr, PeerId, StreamProtocol, Swarm, SwarmBuilder, dcutr, identify,
    multiaddr::Protocol,
    noise, relay,
    swarm::{NetworkBehaviour, SwarmEvent},
    yamux,
};
use serde::Deserialize;
use std::{io, net::Ipv4Addr, time::Duration};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot, watch},
    task::JoinSet,
    time::timeout,
};
use uuid::Uuid;

const TUNNEL: StreamProtocol = StreamProtocol::new("/cove/http-tunnel/1.0.0");
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) type Error = Box<dyn std::error::Error + Send + Sync>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub peer_id: String,
    pub direct: Vec<String>,
    pub relays: Vec<String>,
}

fn target_address(address: &str, target: PeerId, circuit: bool) -> Result<Multiaddr, Error> {
    let addr: Multiaddr = address.parse()?;
    if addr.iter().any(|p| p == Protocol::P2pCircuit) {
        return Err("nested circuits are not supported".into());
    }
    if circuit {
        if !matches!(addr.iter().last(), Some(Protocol::P2p(id)) if id != target) {
            return Err("relay address must identify the relay".into());
        }
        Ok(addr.with(Protocol::P2pCircuit).with(Protocol::P2p(target)))
    } else {
        addr.with_p2p(target)
            .map_err(|_| "direct address identifies another peer".into())
    }
}

#[derive(NetworkBehaviour)]
struct Behaviour {
    relay: relay::client::Behaviour,
    identify: identify::Behaviour,
    dcutr: dcutr::Behaviour,
    streams: streams::Streams,
}

async fn dial(
    swarm: &mut Swarm<Behaviour>,
    peer: PeerId,
    addresses: Vec<Multiaddr>,
) -> Result<(), Error> {
    use libp2p::swarm::dial_opts::{DialOpts, PeerCondition};
    let options = DialOpts::peer_id(peer)
        .condition(PeerCondition::Always)
        .addresses(addresses)
        .build();
    let attempt = options.connection_id();
    swarm.dial(options)?;
    loop {
        match swarm.select_next_some().await {
            SwarmEvent::ConnectionEstablished { peer_id, .. } if peer_id == peer => return Ok(()),
            SwarmEvent::OutgoingConnectionError {
                connection_id,
                error,
                ..
            } if connection_id == attempt => return Err(error.into()),
            _ => {}
        }
    }
}

async fn connect(
    swarm: &mut Swarm<Behaviour>,
    peer: PeerId,
    addresses: &[Multiaddr],
) -> Result<(), Error> {
    if swarm.is_connected(&peer) {
        return Ok(());
    }
    let mut last: Error = "no reachable tunnel address".into();
    let (circuit, direct): (Vec<_>, Vec<_>) = addresses
        .iter()
        .cloned()
        .partition(|address| address.iter().any(|p| p == Protocol::P2pCircuit));
    for (candidates, deadline) in [(direct, Duration::from_secs(2)), (circuit, DIAL_TIMEOUT)] {
        if candidates.is_empty() {
            continue;
        }
        match timeout(deadline, dial(swarm, peer, candidates)).await {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(e)) => last = e,
            Err(e) => last = e.into(),
        }
    }
    Err(last)
}

pub struct Tunnel {
    pub base_url: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

type Open = oneshot::Sender<io::Result<libp2p::Stream>>;

pub async fn open(endpoint: Endpoint) -> Result<Tunnel, Error> {
    let peer: PeerId = endpoint.peer_id.parse()?;
    let mut addresses = Vec::new();
    for (list, circuit) in [(&endpoint.direct, false), (&endpoint.relays, true)] {
        for raw in list.iter().take(16) {
            if let Ok(address) = target_address(raw, peer, circuit) {
                addresses.push(address);
            }
        }
    }
    let mut swarm = SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(
            Default::default(),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_dns()?
        .with_websocket(noise::Config::new, yamux::Config::default)
        .await?
        .with_relay_client(noise::Config::new, yamux::Config::default)?
        .with_behaviour(|key, relay| Behaviour {
            relay,
            streams: streams::Streams::default(),
            identify: identify::Behaviour::new(identify::Config::new(
                "/cove/1".into(),
                key.public(),
            )),
            dcutr: dcutr::Behaviour::new(key.public().to_peer_id()),
        })?
        .with_swarm_config(|config| config.with_idle_connection_timeout(Duration::from_secs(90)))
        .build();
    swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse()?)?;
    connect(&mut swarm, peer, &addresses).await?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let authority = listener.local_addr()?.to_string();
    let prefix = format!("/.cove-tunnel/{}", Uuid::new_v4().simple());
    let base_url = format!("http://{authority}{prefix}/");
    let task = tokio::spawn(async move {
        let mut jobs = JoinSet::new();
        let (tx, mut rx) = mpsc::channel::<Open>(64);
        let (_lifetime, lifetime) = watch::channel(());
        loop {
            tokio::select! {
                Some(_) = jobs.join_next(), if !jobs.is_empty() => {}
                accepted = listener.accept(), if jobs.len() < 256 => {
                    let Ok((socket, _)) = accepted else { break; };
                    jobs.spawn(proxy::serve(socket, tx.clone(), authority.clone(), prefix.clone(), lifetime.clone()));
                }
                Some(reply) = rx.recv() => {
                    if let Err(error) = connect(&mut swarm, peer, &addresses).await {
                        let _ = reply.send(Err(io::Error::other(error.to_string())));
                        continue;
                    }
                    swarm.behaviour_mut().streams.open(peer, reply);
                }
                event = swarm.select_next_some() => {
                    match event {
                        SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received { peer_id, info, .. })) if peer_id == peer => {
                            for addr in info.listen_addrs.into_iter().take(16) {
                                if let Ok(addr) = target_address(&addr.to_string(), peer, false)
                                    && addresses.len() < 48 && !addresses.contains(&addr) { addresses.insert(0, addr); }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    });
    Ok(Tunnel { base_url, task })
}
