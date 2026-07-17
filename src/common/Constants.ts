export const SERVER_PACKAGE = 'com.genymobile.scrcpy.Server';
export const SERVER_VERSION = '3.3.3';
export const SCRCPY_SOCKET_NAME = 'scrcpy_00000000';

const ARGUMENTS = [
    SERVER_VERSION,
    'scid=0',
    'log_level=error',
    'audio=true',
    'audio_codec=opus',
    'audio_bit_rate=128000',
    'tunnel_forward=true',
    'max_size=1920',
    'control=true',
    // Force IDR keyframes every 2 seconds so late-joining clients
    // don't wait long for a decodable frame (default can be 5-10s).
    // repeat-previous-frame-after forces the encoder to keep producing
    // frames even when the screen is static (value in microseconds).
    'video_codec_options=i-frame-interval:int=2,repeat-previous-frame-after:long=100000',
];

export const SERVER_PROCESS_NAME = 'app_process';
// Note: output NOT redirected to /dev/null during debugging so we can see exit reason
export const ARGS_STRING = `/ ${SERVER_PACKAGE} ${ARGUMENTS.join(' ')} 2>&1`;
