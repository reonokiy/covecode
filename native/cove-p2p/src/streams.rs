use super::{Open, TUNNEL};
use libp2p::{
    Multiaddr, PeerId, Stream, StreamProtocol,
    core::{Endpoint, OutboundUpgrade, UpgradeInfo, transport::PortUse, upgrade::DeniedUpgrade},
    swarm::{
        ConnectionDenied, ConnectionId, FromSwarm, NetworkBehaviour, NotifyHandler, OneShotHandler,
        THandler, THandlerInEvent, THandlerOutEvent, ToSwarm,
    },
};
use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    future::{Ready, ready},
    io,
    task::{Context, Poll},
};

#[derive(Debug)]
pub(super) struct OpenStream {
    reply: Open,
    relayed: bool,
}

impl UpgradeInfo for OpenStream {
    type Info = StreamProtocol;
    type InfoIter = std::array::IntoIter<StreamProtocol, 2>;
    fn protocol_info(&self) -> Self::InfoIter {
        [StreamProtocol::new("/http/1.1"), TUNNEL].into_iter()
    }
}

impl OutboundUpgrade<Stream> for OpenStream {
    type Output = Opened;
    type Error = Infallible;
    type Future = Ready<Result<Opened, Infallible>>;
    fn upgrade_outbound(self, stream: Stream, _: StreamProtocol) -> Self::Future {
        let _ = self.reply.send(Ok(super::OpenedStream {
            stream,
            relayed: self.relayed,
        }));
        ready(Ok(Opened))
    }
}

#[derive(Debug)]
pub(super) struct Opened;
impl From<Infallible> for Opened {
    fn from(never: Infallible) -> Self {
        match never {}
    }
}

// Open new streams on the direct connection after hole punching; existing relay streams keep running.
#[derive(Default)]
pub(super) struct Streams {
    paths: HashMap<ConnectionId, (PeerId, bool)>,
    pending: VecDeque<(PeerId, ConnectionId, OpenStream)>,
}

impl Streams {
    pub(super) fn open(&mut self, peer: PeerId, reply: Open) {
        let path = self
            .paths
            .iter()
            .filter(|(_, (id, _))| *id == peer)
            .min_by_key(|(_, (_, relayed))| *relayed);
        if let Some((id, (_, relayed))) = path {
            self.pending.push_back((
                peer,
                *id,
                OpenStream {
                    reply,
                    relayed: *relayed,
                },
            ));
        } else {
            let _ = reply.send(Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "Environment disconnected",
            )));
        }
    }
}

impl NetworkBehaviour for Streams {
    type ConnectionHandler = OneShotHandler<DeniedUpgrade, OpenStream, Opened>;
    type ToSwarm = ();

    fn handle_established_inbound_connection(
        &mut self,
        _: ConnectionId,
        _: PeerId,
        _: &Multiaddr,
        _: &Multiaddr,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        Ok(OneShotHandler::new(
            libp2p::swarm::SubstreamProtocol::new(DeniedUpgrade, ()),
            Default::default(),
        ))
    }
    fn handle_established_outbound_connection(
        &mut self,
        _: ConnectionId,
        _: PeerId,
        _: &Multiaddr,
        _: Endpoint,
        _: PortUse,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        Ok(OneShotHandler::new(
            libp2p::swarm::SubstreamProtocol::new(DeniedUpgrade, ()),
            Default::default(),
        ))
    }
    fn on_swarm_event(&mut self, event: FromSwarm) {
        match event {
            FromSwarm::ConnectionEstablished(e) => {
                self.paths
                    .insert(e.connection_id, (e.peer_id, e.endpoint.is_relayed()));
            }
            FromSwarm::ConnectionClosed(e) => {
                self.paths.remove(&e.connection_id);
            }
            _ => {}
        }
    }
    fn on_connection_handler_event(
        &mut self,
        _: PeerId,
        _: ConnectionId,
        _: THandlerOutEvent<Self>,
    ) {
    }
    fn poll(&mut self, _: &mut Context<'_>) -> Poll<ToSwarm<(), THandlerInEvent<Self>>> {
        match self.pending.pop_front() {
            Some((peer_id, id, event)) => Poll::Ready(ToSwarm::NotifyHandler {
                peer_id,
                handler: NotifyHandler::One(id),
                event,
            }),
            None => Poll::Pending,
        }
    }
}
