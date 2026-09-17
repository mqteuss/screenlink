export function mediaPermissionKind(details) {
  const requestedMedia = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];

  // Electron 44 represents getDisplayMedia as a generic media permission with
  // no mediaTypes. The display-media handler performs the source/origin checks.
  if (requestedMedia.length === 0) return 'display';
  if (requestedMedia.includes('audio') && !requestedMedia.includes('video')) return 'microphone';
  return 'deny';
}
