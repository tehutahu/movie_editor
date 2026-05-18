import path from "node:path";

export function guessVideoMimeType(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  switch (ext) {
    case "mp4":
      return "video/mp4";
    case "mkv":
      return "video/x-matroska";
    case "avi":
      return "video/x-msvideo";
    case "mov":
      return "video/quicktime";
    case "flv":
      return "video/x-flv";
    case "wmv":
      return "video/x-ms-wmv";
    default:
      return "application/octet-stream";
  }
}
