import type { Clip } from './editor/types';
import { clipHasAudioFade } from './editor/clipAudioFade';
import { compileAudioFade } from './editor/audioFadeDsp';
import { assertAudioFadeAvailable, probeMedia } from './ffmpeg';
/** Only active fades enter this path: legacy exports do no additional work. */
export async function audioFadeExportFilter(clip:Clip,preparedPath:string):Promise<string>{
  if(!clipHasAudioFade(clip))return '';
  await assertAudioFadeAvailable();
  const json=await probeMedia(preparedPath),rate=Number(json.streams?.find(s=>s.codec_type==='audio')?.sample_rate);
  const filter=compileAudioFade(clip.audioFade,rate).filter;
  return filter?filter+',':'';
}
