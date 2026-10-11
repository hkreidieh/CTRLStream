/**
 * Every OBS config key ctrlstream reads or writes, with where it was verified.
 *
 * Sources (all fetched 2026-10-11):
 *  [SRC-DEF]  obs-studio 32.2.2 frontend/widgets/OBSBasic.cpp, InitBasicConfigDefaults() and
 *             InitBasicConfigDefaults2(): section/key names and defaults.
 *  [SRC-SIMPLE] obs-studio 32.2.2 frontend/utility/SimpleOutput.cpp: which keys the simple output
 *             handler reads in its constructor and which it reads at each start.
 *  [SRC-ADV]  obs-studio 32.2.2 frontend/utility/AdvancedOutput.cpp.
 *  [SRC-HPP]  obs-studio 32.2.2 frontend/widgets/OBSBasic.hpp, SIMPLE_ENCODER_* constants.
 *  [SRC-SET]  obs-studio 32.2.2 frontend/settings/OBSBasicSettings.cpp: valid values offered in
 *             the settings UI (record formats, qualities, presets).
 *  [SRC-WS]   obs-websocket 5.7.4 (bundled with OBS 32.2.2) src/requesthandler/RequestHandler_Config.cpp
 *             and src/Config.cpp.
 *  [REAL]     a real OBS 32.2.2 install on macOS 26.2 (Apple M2 Pro), first launched 2026-10-11.
 *             A fresh profile's basic.ini holds only `[General] Name=`: OBS writes a key only once
 *             it differs from the in-memory default, so reads must fall back to DEFAULTS below.
 *             Keys written live through SetProfileParameter were read back from the real
 *             basic.ini during the integration run (see REAL_VERIFIED_KEYS).
 */

export const SEC = {
  General: 'General',
  Output: 'Output',
  SimpleOutput: 'SimpleOutput',
  AdvOut: 'AdvOut',
  Video: 'Video',
  Audio: 'Audio',
  Stream1: 'Stream1',
} as const;

/** basic.ini keys. Each verified in [SRC-DEF] unless noted. */
export const KEYS = {
  General: { Name: 'Name' },
  Output: { Mode: 'Mode' /* "Simple" | "Advanced" */ },
  SimpleOutput: {
    VBitrate: 'VBitrate',
    ABitrate: 'ABitrate',
    StreamEncoder: 'StreamEncoder', // [SRC-DEF] InitBasicConfigDefaults2
    StreamAudioEncoder: 'StreamAudioEncoder',
    Preset: 'Preset', // x264 preset; also the fallback preset key for unknown encoders [SRC-SIMPLE]
    NVENCPreset2: 'NVENCPreset2',
    QSVPreset: 'QSVPreset', // [SRC-SIMPLE] Update()
    AMDPreset: 'AMDPreset', // [SRC-SIMPLE] Update()
    AMDAV1Preset: 'AMDAV1Preset', // [SRC-SIMPLE] Update()
    UseAdvanced: 'UseAdvanced',
    x264Settings: 'x264Settings', // [SRC-SIMPLE]
    RecQuality: 'RecQuality',
    RecFormat2: 'RecFormat2',
    RecEncoder: 'RecEncoder', // [SRC-DEF] InitBasicConfigDefaults2
    RecAudioEncoder: 'RecAudioEncoder',
    RecTracks: 'RecTracks',
    RecRB: 'RecRB',
    RecRBTime: 'RecRBTime',
    RecRBSize: 'RecRBSize',
    FilePath: 'FilePath',
    FileNameWithoutSpace: 'FileNameWithoutSpace', // [SRC-SIMPLE] ConfigureRecording(); no default set
    MuxerCustom: 'MuxerCustom', // [SRC-SIMPLE]
  },
  AdvOut: {
    Encoder: 'Encoder',
    AudioEncoder: 'AudioEncoder',
    RecEncoder: 'RecEncoder', // "none" = use the stream encoder
    RecAudioEncoder: 'RecAudioEncoder',
    RecType: 'RecType',
    RecFilePath: 'RecFilePath',
    RecFormat2: 'RecFormat2',
    RecTracks: 'RecTracks',
    TrackIndex: 'TrackIndex',
    Track1Bitrate: 'Track1Bitrate',
    ApplyServiceSettings: 'ApplyServiceSettings',
  },
  Video: {
    BaseCX: 'BaseCX',
    BaseCY: 'BaseCY',
    OutputCX: 'OutputCX',
    OutputCY: 'OutputCY',
    FPSType: 'FPSType', // 0 common, 1 integer, 2 fraction; SetVideoSettings always writes 2 [SRC-WS]
    FPSCommon: 'FPSCommon',
    FPSInt: 'FPSInt',
    FPSNum: 'FPSNum',
    FPSDen: 'FPSDen',
    ScaleType: 'ScaleType',
  },
  Audio: {
    SampleRate: 'SampleRate',
    ChannelSetup: 'ChannelSetup', // "Mono" | "Stereo" | "2.1" | "4.0" | "4.1" | "5.1" | "7.1"
  },
  Stream1: { IgnoreRecommended: 'IgnoreRecommended' },
} as const;

/**
 * Defaults OBS holds in memory when a key is absent from basic.ini. [SRC-DEF]
 * StreamEncoder/RecEncoder default to "nvenc" when ffmpeg_nvenc is available, else "x264".
 * FilePath default is the OS videos folder (GetDefaultVideoSavePath), not reproduced here.
 * BaseCX/BaseCY/OutputCX/OutputCY defaults depend on the primary monitor.
 */
export const DEFAULTS: Record<string, Record<string, string>> = {
  Output: { Mode: 'Simple' },
  SimpleOutput: {
    VBitrate: '6000',
    ABitrate: '160',
    UseAdvanced: 'false',
    Preset: 'veryfast',
    NVENCPreset2: 'p5',
    RecQuality: 'Stream',
    RecRB: 'false',
    RecRBTime: '20',
    RecRBSize: '512',
    StreamAudioEncoder: 'aac',
    RecAudioEncoder: 'aac',
    RecTracks: '1',
    StreamEncoder: 'x264',
    RecEncoder: 'x264',
    FileNameWithoutSpace: 'false',
  },
  AdvOut: {
    ApplyServiceSettings: 'true',
    TrackIndex: '1',
    Encoder: 'obs_x264',
    RecType: 'Standard',
    RecTracks: '1',
    RecEncoder: 'none',
    Track1Bitrate: '160',
  },
  Video: {
    FPSType: '0',
    FPSCommon: '30',
    FPSInt: '30',
    FPSNum: '30',
    FPSDen: '1',
    ScaleType: 'bicubic',
  },
  Audio: { SampleRate: '48000', ChannelSetup: 'Stereo' },
  Stream1: { IgnoreRecommended: 'false' },
};

/** Platform default container: hybrid_mov on macOS, hybrid_mp4 elsewhere. [SRC-DEF] DEFAULT_CONTAINER */
export function defaultRecFormat(platform: string): string {
  return platform === 'darwin' ? 'hybrid_mov' : 'hybrid_mp4';
}

/** RecFormat2 values the settings UI offers. [SRC-SET] ("hls" is Advanced-only.) */
export const REC_FORMATS = ['flv', 'mkv', 'mp4', 'mov', 'hybrid_mp4', 'hybrid_mov', 'fragmented_mp4', 'fragmented_mov', 'mpegts'] as const;
export const REC_QUALITIES = ['Stream', 'Small', 'HQ', 'Lossless'] as const;
export const CHANNEL_SETUPS = ['Mono', 'Stereo', '2.1', '4.0', '4.1', '5.1', '7.1'] as const;
export const SAMPLE_RATES = [44100, 48000] as const;

export type EncoderFamily = 'x264' | 'nvenc' | 'amf' | 'qsv' | 'videotoolbox' | 'av1' | 'other';

export interface SimpleEncoderInfo {
  /** libobs encoder ids this simple-mode id resolves to, newest first. */
  libobs: string[];
  family: EncoderFamily;
  codec: 'h264' | 'hevc' | 'av1';
  /** Which [SimpleOutput] key holds its preset. [SRC-SIMPLE] Update(). Apple has none. */
  presetKey: 'Preset' | 'NVENCPreset2' | 'QSVPreset' | 'AMDPreset' | 'AMDAV1Preset' | null;
  presets: string[] | null;
  /** x264_lowcpu is only offered as a recording encoder. [SRC-SET] */
  recordOnly?: boolean;
}

/**
 * Simple-mode encoder identifiers as stored in StreamEncoder / RecEncoder, verified against
 * [SRC-HPP] SIMPLE_ENCODER_* and get_simple_output_encoder() in [SRC-SIMPLE].
 *
 * DESIGN 3.2 listed `qsv_hevc`: it does not exist in OBS 32.2.2 (there is no SIMPLE_ENCODER_QSV_HEVC),
 * so it is not accepted here. `x264_lowcpu` exists and is recording-only.
 * libobs ids: OBS 31+ native NVENC is obs_nvenc_*_tex; `jim_nvenc`/`jim_hevc_nvenc`/`jim_av1_nvenc`
 * are the pre-31 ids still found in old logs; ffmpeg_nvenc/ffmpeg_hevc_nvenc are the fallback.
 */
export const SIMPLE_ENCODERS: Record<string, SimpleEncoderInfo> = {
  x264: { libobs: ['obs_x264'], family: 'x264', codec: 'h264', presetKey: 'Preset', presets: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast'] },
  x264_lowcpu: { libobs: ['obs_x264'], family: 'x264', codec: 'h264', presetKey: 'Preset', presets: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast'], recordOnly: true },
  nvenc: { libobs: ['obs_nvenc_h264_tex', 'ffmpeg_nvenc', 'jim_nvenc'], family: 'nvenc', codec: 'h264', presetKey: 'NVENCPreset2', presets: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] },
  nvenc_hevc: { libobs: ['obs_nvenc_hevc_tex', 'ffmpeg_hevc_nvenc', 'jim_hevc_nvenc'], family: 'nvenc', codec: 'hevc', presetKey: 'NVENCPreset2', presets: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] },
  nvenc_av1: { libobs: ['obs_nvenc_av1_tex', 'jim_av1_nvenc'], family: 'nvenc', codec: 'av1', presetKey: 'NVENCPreset2', presets: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] },
  amd: { libobs: ['h264_texture_amf', 'h264_fallback_amf', 'amd_amf_h264'], family: 'amf', codec: 'h264', presetKey: 'AMDPreset', presets: ['speed', 'balanced', 'quality'] },
  amd_hevc: { libobs: ['h265_texture_amf', 'h265_fallback_amf', 'amd_amf_h265'], family: 'amf', codec: 'hevc', presetKey: 'AMDPreset', presets: ['speed', 'balanced', 'quality'] },
  amd_av1: { libobs: ['av1_texture_amf', 'av1_fallback_amf'], family: 'amf', codec: 'av1', presetKey: 'AMDAV1Preset', presets: ['speed', 'balanced', 'quality', 'highQuality'] },
  qsv: { libobs: ['obs_qsv11_v2', 'obs_qsv11', 'obs_qsv11_soft_v2'], family: 'qsv', codec: 'h264', presetKey: 'QSVPreset', presets: ['speed', 'balanced', 'quality'] },
  qsv_av1: { libobs: ['obs_qsv11_av1', 'obs_qsv11_av1_soft'], family: 'qsv', codec: 'av1', presetKey: 'QSVPreset', presets: ['speed', 'balanced', 'quality'] },
  apple_h264: { libobs: ['com.apple.videotoolbox.videoencoder.ave.avc'], family: 'videotoolbox', codec: 'h264', presetKey: null, presets: null },
  apple_hevc: { libobs: ['com.apple.videotoolbox.videoencoder.ave.hevc'], family: 'videotoolbox', codec: 'hevc', presetKey: null, presets: null },
};

export const SIMPLE_STREAM_ENCODER_IDS = Object.keys(SIMPLE_ENCODERS).filter((k) => !SIMPLE_ENCODERS[k]!.recordOnly);

/** Classify a libobs encoder id (as printed under "Available Encoders" in the log). */
export function encoderFamily(libobsId: string): EncoderFamily {
  const id = libobsId.toLowerCase();
  if (id.includes('nvenc')) return 'nvenc';
  if (id.includes('amf')) return 'amf';
  if (id.includes('qsv')) return 'qsv';
  if (id.startsWith('com.apple.videotoolbox')) return 'videotoolbox';
  if (id === 'obs_x264') return 'x264';
  if (id.includes('av1')) return 'av1';
  return 'other';
}

export const FAMILY_HINTS: Record<EncoderFamily, string> = {
  nvenc: 'NVIDIA hardware encoder. Best choice on NVIDIA GPUs: near-zero CPU cost, quality comparable to x264 medium at p5-p7.',
  amf: 'AMD hardware encoder. Use on AMD GPUs; HEVC/AV1 look better than H.264 at the same bitrate where the platform accepts them.',
  qsv: 'Intel Quick Sync hardware encoder. Good choice on Intel CPUs with integrated graphics or Arc GPUs.',
  videotoolbox: 'Apple VideoToolbox hardware encoder. The right default on Apple silicon Macs.',
  x264: 'Software (CPU) encoder. Excellent quality but CPU-heavy; prefer a hardware encoder when one is listed.',
  av1: 'Software AV1 encoder. Very CPU-heavy; not for live streaming on most machines.',
  other: 'Special-purpose encoder (for example ProRes). Not for streaming.',
};

/**
 * When a [SimpleOutput] change made with SetProfileParameter takes effect. [SRC-WS]
 * SetProfileParameter only edits the profile config and saves basic.ini; it does not reset
 * outputs. [SRC-SIMPLE]: the SimpleOutput constructor reads the encoder ids, the recording
 * quality, the replay buffer switch and the hybrid/ffmpeg muxer choice; the constructor only runs
 * when outputs are reset (OBS start, profile switch, or OK/Apply in Settings). Everything else is
 * read by Update()/UpdateRecording()/ConfigureRecording() at each stream or recording start.
 * Confirmed on the real OBS 32.2.2, see REAL_VERIFIED_APPLY below.
 */
export type ApplyTiming = 'next_start' | 'restart';
export const SIMPLE_OUTPUT_APPLY: Record<string, ApplyTiming> = {
  VBitrate: 'next_start',
  ABitrate: 'next_start',
  Preset: 'next_start',
  NVENCPreset2: 'next_start',
  QSVPreset: 'next_start',
  AMDPreset: 'next_start',
  AMDAV1Preset: 'next_start',
  UseAdvanced: 'next_start',
  x264Settings: 'next_start',
  FilePath: 'next_start',
  FileNameWithoutSpace: 'next_start',
  MuxerCustom: 'next_start',
  RecTracks: 'next_start',
  RecRBTime: 'next_start',
  RecRBSize: 'next_start',
  // Read only in the SimpleOutput constructor:
  StreamEncoder: 'restart',
  StreamAudioEncoder: 'restart',
  RecEncoder: 'restart',
  RecAudioEncoder: 'restart',
  RecQuality: 'restart',
  RecRB: 'restart',
  // The extension is read at each start, but the muxer (hybrid mp4/mov vs ffmpeg) is chosen in
  // the constructor, so switching between a hybrid format and any other needs a restart.
  RecFormat2: 'restart',
};

/** [Output] Mode is read in OBSBasic::ResetOutputs(): restart. [Audio] needs a full restart. */
export const OTHER_APPLY: Record<string, ApplyTiming> = {
  'Output.Mode': 'restart',
  'Audio.SampleRate': 'restart',
  'Audio.ChannelSetup': 'restart',
};

/**
 * Answers from the real OBS 32.2.2 on macOS 26.2 (Apple M2 Pro), 2026-10-11, profile
 * ctrlstream-test, recordings with RecQuality=Stream so the recording used the stream encoder.
 * Each value: what was changed live with SetProfileParameter, and what the next recording used
 * according to the encoder lines OBS logs at "==== Recording Start".
 */
export const REAL_VERIFIED_APPLY: Record<string, string> = {
  'SimpleOutput.VBitrate':
    'next_start. 2500 then 4000 set live with no restart: the next recordings logged "[x264 encoder: simple_video_stream] bitrate: 2500" then "bitrate: 4000".',
  'SimpleOutput.StreamEncoder':
    'restart. x264 -> apple_h264 set live: the next recording still logged the x264 encoder. After an outputs reset (switching to another profile and back) it logged "[VideoToolbox simple_video_stream: h264]".',
  'SimpleOutput.RecFormat2':
    'restart. hybrid_mov -> mkv set live: the next recording wrote a Hybrid MOV container into a file named ".mkv" (output kind mov_output). After an outputs reset it used ffmpeg_muxer and a real MKV.',
  'outputs reset':
    'OBS restart, a profile switch (ActivateProfile -> ResetProfileData -> ResetOutputs), or OK/Apply in Settings. SetProfileParameter alone never resets outputs.',
  'Stream1.IgnoreRecommended':
    'false (default) with rtmp_common Twitch: VBitrate 8000 was encoded at 6000 kbps with keyint 60 (2 s at 30 fps); OBS clamps to services.json recommended "max video bitrate" and applies "keyint".',
  'rtmp_custom keyframes':
    'Simple mode with rtmp_custom sets no keyframe interval: x264 logged "keyint: 250" (frames, its default); VideoToolbox logged "keyint: 2 (s)" (its own default).',
};

/** Keys read back from the real basic.ini of a profile created with CreateProfile and then used. */
export const REAL_VERIFIED_KEYS: string[] = [
  'Output.Mode',
  'Stream1.IgnoreRecommended',
  'SimpleOutput.FilePath',
  'SimpleOutput.RecFormat2',
  'SimpleOutput.VBitrate',
  'SimpleOutput.ABitrate',
  'SimpleOutput.UseAdvanced',
  'SimpleOutput.Preset',
  'SimpleOutput.NVENCPreset2',
  'SimpleOutput.RecQuality',
  'SimpleOutput.RecRB',
  'SimpleOutput.RecRBTime',
  'SimpleOutput.RecRBSize',
  'SimpleOutput.StreamAudioEncoder',
  'SimpleOutput.RecAudioEncoder',
  'SimpleOutput.RecTracks',
  'SimpleOutput.StreamEncoder',
  'SimpleOutput.RecEncoder',
  'AdvOut.ApplyServiceSettings',
  'AdvOut.TrackIndex',
  'AdvOut.Encoder',
  'AdvOut.RecType',
  'AdvOut.RecFilePath',
  'AdvOut.RecFormat2',
  'AdvOut.RecTracks',
  'AdvOut.RecEncoder',
  'AdvOut.Track1Bitrate',
  'AdvOut.AudioEncoder',
  'AdvOut.RecAudioEncoder',
  'Video.BaseCX',
  'Video.BaseCY',
  'Video.OutputCX',
  'Video.OutputCY',
  'Video.FPSType',
  'Video.FPSCommon',
  'Video.FPSInt',
  'Video.FPSNum',
  'Video.FPSDen',
  'Video.ScaleType',
  'Audio.SampleRate',
  'Audio.ChannelSetup',
];

/**
 * Keys used here that never appeared in a real file because OBS only writes them from its own
 * Settings dialog; verified in source only: SimpleOutput.QSVPreset, AMDPreset, AMDAV1Preset,
 * x264Settings, MuxerCustom, FileNameWithoutSpace.
 *
 * Simple-mode encoder facts also confirmed by the skills agent (knowledge/encoders.json): there is no
 * qsv_hevc Simple-mode id in 30.2 or 32.2 (Intel HEVC is Advanced-only, obs_qsv11_hevc);
 * x264_lowcpu is recording-only; OBS 31+ logs obs_nvenc_*_tex and hides the deprecated jim_nvenc
 * ids; Apple encoders are offered in Simple mode only on Apple Silicon with macOS 13 or later.
 * On the real Mac the log listed com.apple.videotoolbox.videoencoder.ave.avc and .ave.hevc, and
 * the default StreamEncoder was x264 (no ffmpeg_nvenc), matching InitBasicConfigDefaults2.
 */
