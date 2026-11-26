use super::*;

#[test]
fn binds_dial_addresses_to_the_expected_peer() {
    let target = libp2p::PeerId::random();
    let other = libp2p::PeerId::random();
    let transport = "/ip4/192.0.2.1/tcp/4001";
    let relay = format!("{transport}/p2p/{other}");
    assert_eq!(
        target_address(&relay, target, true).unwrap().to_string(),
        format!("{relay}/p2p-circuit/p2p/{target}")
    );
    assert!(target_address(&relay, target, false).is_err());
    assert!(target_address(transport, target, true).is_err());
    assert!(target_address(&format!("{relay}/p2p-circuit/p2p/{other}"), target, true).is_err());
}
