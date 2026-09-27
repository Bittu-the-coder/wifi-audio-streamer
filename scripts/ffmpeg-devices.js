export function parseDshowDevices(output) {
  const devices = []
  const modern = /"([^"]+)"\s+\((audio|video)\)/g
  let match
  while ((match = modern.exec(output))) {
    if (match[2] === 'audio') devices.push(match[1])
  }
  if (devices.length) return devices

  const legacy = /audio="([^"]+)"/g
  while ((match = legacy.exec(output))) devices.push(match[1])
  return devices
}
