/**
 * Validation utilities for streams and recordings
 */

/**
 * Validate RTSP URL format
 * @param url - The URL to validate
 * @returns { valid: boolean, error?: string }
 */
export function validateRtspUrl(url: string): { valid: boolean; error?: string } {
  if (!url || !url.trim()) {
    return { valid: false, error: "RTSP URL cannot be empty" };
  }

  const trimmed = url.trim().toLowerCase();

  // Check if it starts with rtsp://
  if (!trimmed.startsWith("rtsp://")) {
    return { valid: false, error: "RTSP URL must start with rtsp://" };
  }

  // Basic format validation: rtsp://host[:port][/path]
  try {
    // Try to parse as URL (just for basic syntax checking)
    // Note: URL() doesn't recognize rtsp:// as a valid protocol, so we'll do manual validation
    const urlWithHttp = trimmed.replace("rtsp://", "http://");
    new URL(urlWithHttp);
  } catch {
    return { valid: false, error: "RTSP URL format is invalid" };
  }

  // Must have at least one character after rtsp://
  if (trimmed.length < 9) {
    return { valid: false, error: "RTSP URL must have a host" };
  }

  return { valid: true };
}

/**
 * Quick check if URL is a valid RTSP URL
 * @param url - The URL to check
 * @returns true if valid, false otherwise
 */
export function isValidRtspUrl(url: string): boolean {
  return validateRtspUrl(url).valid;
}

/**
 * Validate recording duration
 * @param durationSeconds - Duration in seconds
 * @param minSeconds - Minimum allowed duration (default: 1)
 * @returns { valid: boolean, error?: string }
 */
export function validateRecordingDuration(
  durationSeconds: number,
  minSeconds: number = 1
): { valid: boolean; error?: string } {
  if (durationSeconds < minSeconds) {
    const minFormatted = minSeconds >= 60
      ? `${Math.floor(minSeconds / 60)}m ${minSeconds % 60}s`
      : `${minSeconds}s`;
    return {
      valid: false,
      error: `Recording duration must be at least ${minFormatted}. Record for a longer duration before saving.`,
    };
  }

  return { valid: true };
}
