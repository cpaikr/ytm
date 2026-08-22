export function isNodeCliArtifact(path) {
  const segments = String(path).replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.slice(0, -1).includes("bin")) return true;

  const fileName = segments.at(-1)?.toLowerCase() || "";
  const extension = fileName.match(/(?:\.d\.[cm]?ts|\.[cm]?[jt]s)$/)?.[0];
  if (!extension) return false;
  const stem = fileName.slice(0, -extension.length);
  return /(?:^|[-_.])cli(?:$|[-_.])/.test(stem);
}
