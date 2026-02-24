export function shouldRequirePiPairing(
  rawValue: string | undefined = process.env.PI_BRIDGE_REQUIRE_PAIRING,
): boolean {
  const normalized = rawValue?.trim().toLowerCase() ?? ''
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}
