import { PiPairingGuard } from './piPairing.js'
import { PiRpcProcess } from './piRpcProcess.js'
import { shouldRequirePiPairing } from './pairingConfig.js'

type PiBridgeContext = {
  pairing: PiPairingGuard
  runtime: PiRpcProcess
}

let cachedContext: PiBridgeContext | null = null

export function getPiBridgeContext(): PiBridgeContext {
  if (cachedContext) {
    return cachedContext
  }

  cachedContext = {
    pairing: new PiPairingGuard({
      requirePairing: shouldRequirePiPairing(),
    }),
    runtime: new PiRpcProcess(),
  }
  return cachedContext
}
