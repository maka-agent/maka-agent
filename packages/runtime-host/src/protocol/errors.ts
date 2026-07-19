export class RuntimeHostProtocolError extends Error {
  constructor(
    readonly code: 'invalid_frame' | 'frame_too_large' | 'invalid_utf8' | 'invalid_json',
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHostProtocolError';
  }
}

export function invalidProtocolFrame(message: string): RuntimeHostProtocolError {
  return new RuntimeHostProtocolError('invalid_frame', message);
}
