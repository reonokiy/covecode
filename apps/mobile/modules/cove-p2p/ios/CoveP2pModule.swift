import ExpoModulesCore
import Foundation

public final class CoveP2pModule: Module {
  private let lock = NSLock()
  private var tunnels = Set<String>()
  private var destroyed = false

  public func definition() -> ModuleDefinition {
    Name("CoveP2p")
    AsyncFunction("open") { (endpoint: String) -> String in
      guard let result = endpoint.withCString({ cove_tunnel_open($0) }) else {
        throw NSError(domain: "CoveP2p", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not connect to the environment peer"])
      }
      defer { cove_tunnel_free(result) }
      let url = String(cString: result)
      self.lock.lock()
      defer { self.lock.unlock() }
      guard !self.destroyed else {
        url.withCString { cove_tunnel_close($0) }
        throw CancellationError()
      }
      self.tunnels.insert(url)
      return url
    }
    Function("close") { (url: String) in
      self.lock.lock()
      defer { self.lock.unlock() }
      if self.tunnels.remove(url) != nil { url.withCString { cove_tunnel_close($0) } }
    }
    OnDestroy {
      self.lock.lock()
      defer { self.lock.unlock() }
      self.destroyed = true
      for url in self.tunnels { url.withCString { cove_tunnel_close($0) } }
      self.tunnels.removeAll()
    }
  }
}
