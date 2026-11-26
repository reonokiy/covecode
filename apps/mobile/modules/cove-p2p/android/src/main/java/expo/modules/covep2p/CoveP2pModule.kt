package expo.modules.covep2p

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.CancellationException

internal object NativeTunnel {
  init {
    System.loadLibrary("cove_p2p")
  }

  @JvmStatic external fun open(context: Context, endpoint: String): String

  @JvmStatic external fun close(url: String)
}

class CoveP2pModule : Module() {
  private val tunnels = mutableSetOf<String>()
  private var destroyed = false

  override fun definition() = ModuleDefinition {
    Name("CoveP2p")
    AsyncFunction("open") { endpoint: String ->
      val context = requireNotNull(appContext.reactContext).applicationContext
      val url = NativeTunnel.open(context, endpoint)
      synchronized(tunnels) {
        if (destroyed) {
          NativeTunnel.close(url)
          throw CancellationException("Cove tunnel module closed")
        }
        tunnels.add(url)
      }
      url
    }
    Function("close") { url: String ->
      synchronized(tunnels) { if (tunnels.remove(url)) NativeTunnel.close(url) }
    }
    OnDestroy {
      synchronized(tunnels) {
        destroyed = true
        tunnels.forEach(NativeTunnel::close)
        tunnels.clear()
      }
    }
  }
}
