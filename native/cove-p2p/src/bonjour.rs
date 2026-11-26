use super::{Error, Multiaddr, PeerId, target_address};
use std::ffi::{CString, c_char};

unsafe extern "C" {
    fn cove_lan_lookup(peer: *const c_char, output: *mut u8, capacity: usize) -> usize;
}

pub async fn addresses(peer: PeerId) -> Result<Vec<Multiaddr>, Error> {
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<_>, Error> {
        let name = CString::new(peer.to_string())?;
        let mut buffer = [0u8; 4096];
        // The synchronous Bonjour lookup writes at most capacity bytes and retains no pointers.
        let used = unsafe { cove_lan_lookup(name.as_ptr(), buffer.as_mut_ptr(), buffer.len()) };
        let addresses = std::str::from_utf8(&buffer[..used])?
            .lines()
            .filter_map(|address| target_address(address, peer, false).ok())
            .collect();
        Ok(addresses)
    })
    .await??;
    if result.is_empty() {
        return Err("LAN peer was not found on this network".into());
    }
    Ok(result)
}
