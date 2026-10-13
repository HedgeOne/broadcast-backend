import { AppError } from "../../lib/errors.js";

// Client-facing media errors. Messages are user-safe; codes are stable.
export const mediaErrors = {
  unavailable: () =>
    new AppError(503, "MEDIA_UNAVAILABLE", "Sharing files isn't available right now."),

  // Also returned for other people's uploads and for attachments the
  // caller may not see, so neither existence nor ownership is revealed.
  notFound: () => new AppError(404, "MEDIA_NOT_FOUND", "This file is not available."),

  tooLarge: (maxBytes: number) =>
    new AppError(413, "FILE_TOO_LARGE", `Files can be up to ${formatMb(maxBytes)}.`, { maxBytes }),

  unsupportedType: () =>
    new AppError(415, "UNSUPPORTED_FILE_TYPE", "This type of file can't be shared."),

  typeMismatch: () =>
    new AppError(422, "FILE_TYPE_MISMATCH", "The file type doesn't match the kind of attachment."),

  extensionMismatch: () =>
    new AppError(422, "FILE_EXTENSION_MISMATCH", "The file name doesn't match its type."),

  clientUploadConflict: () =>
    new AppError(
      409,
      "CLIENT_UPLOAD_CONFLICT",
      "This upload ID was already used for another file.",
    ),

  // The object hasn't arrived in storage yet; the client may (re)upload
  // while the upload URL is valid and complete again.
  uploadIncomplete: () =>
    new AppError(409, "UPLOAD_INCOMPLETE", "The file hasn't finished uploading."),

  uploadExpired: () =>
    new AppError(410, "UPLOAD_EXPIRED", "This upload expired. Start the upload again."),

  // Verification refused the object (wrong size, type or content).
  uploadRejected: (reason: string) =>
    new AppError(422, "UPLOAD_REJECTED", "This file couldn't be verified.", { reason }),

  uploadInUse: () =>
    new AppError(409, "UPLOAD_IN_USE", "This file was already sent and can't be removed here."),

  // Sending with an upload that isn't the sender's, isn't verified, was
  // removed, or doesn't match the message type.
  attachmentInvalid: () =>
    new AppError(422, "ATTACHMENT_INVALID", "This attachment can't be sent. Upload it again."),

  // Setting a photo with uploads that aren't the caller's, aren't verified
  // images made for that kind of photo, or were already used.
  photoInvalid: () =>
    new AppError(422, "PHOTO_INVALID", "This photo can't be used. Choose it again."),
};

function formatMb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
