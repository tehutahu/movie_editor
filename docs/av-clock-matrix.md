# 異原点AVの再現マトリクス（2026-10-22）

基準main: `af2eaa8`（PR92）。全素材は64×64、2秒の合成MP4。30fpsの赤／緑／青／黄を0.5秒ごとに切り替え、48kHz AACには0.5〜0.52秒の2kHz pulseを置いた。VFRは先頭0.5秒だけ偶数frameを残し、その後は全frameを保持（53frames/2秒）。公開・実ユーザー媒体・追加サービスは使用していない。

表は入力側 `-ss 0.1 -i input -t 0.6 -c:v libx264 -c:a aac` の旧抽出を比較したもの。PR92のCFR修復を通した結果とは区別する。映像は復号後fps30へ揃えた中央色、pulseはmono48kHz復号の10ms RMS窓で測定し、sample精度の証拠にはしない。systemはffmpeg7.1.5／probe7、bundledはffmpeg7.0.2／probe4。

| 指定offset v/a | 実MP4 start v/a/format | 旧systemの最初の緑 / pulse | 判定 |
| --- | --- | --- | --- |
| 0 / 0 | 0 / 0 / 0 | .4 / .4秒 | 基準正常 |
| -.2 / 0 | 0 / 0 / 0 | .2 / .4秒 | edit listで負映像を切捨て。実負原点ではない |
| 0 / -.2 | 0 / 0 / 0 | .4 / .2秒 | edit listで負音声を切捨て。実負原点ではない |
| 0 / +.2 | 0 / .178 / 0 | .4 / .54秒 | AAC primingを含む別音声原点。今回未修復 |
| +.2 / +.1 | .2 / .078 / .078 | .5333 / .42秒 | 映像・音声・format原点が異なる。今回未修復 |
| -.2 / -.1 | 0 / 0 / 0 | .2 / .3秒 | 両streamとも編集で正規化 |
| +2 / 0 CFR | 2 / 0 / 0 | 両stream欠落 | PR92で既に限定修復済みの対照 |
| 0 / 0 VFR | 0 / 0 / 0 | .4 / .4秒 | 既存出力を保持 |
| +2 / 0 VFR | 2 / 0 / 0 | 両stream欠落 | 今回の最小修復対象 |

bundledでは上表の色／pulse結果は同じ。+2のCFR/VFR旧抽出だけは18映像framesがあり音声なしとなり、systemの0streamと異なる。いずれも「明確な不完全出力」として判別する。

追加mux対照: `-copyts -itsoffset -.2`、`-avoid_negative_ts disabled`でTSへcopyすると実startはvideo-.2/audio-.021333/format-.2。Chromiumはmedia error4でdemux拒否し、preview時計の検証対象にできなかった。MKVではvideo0/audio-.021/format-.021となり、旧抽出に両streamがなかった。修復対象には拡張しない。

独立ブラウザ調査では、別の44.1kHz AAC合成素材でも正audio原点によるpulse遅延を確認した（実audio+.176009、video0）。video+.2/audio+.076009ではHTML較正値+.076009が映像先頭として扱われ、source.5が赤、source1が緑となった。AAC primingを含むため「全原点を単純に足す」一般化は行わない。

## 再現方法

以下の同じ合成inputをoffsetだけ変えてmuxし、実metadataを毎回取得する。要求offsetを実原点と見なさない。

```sh
ffmpeg -f lavfi -i color=red:s=64x64:r=30:d=2 -vf 'drawbox=color=green:t=fill:enable=gte(n\,15)*lt(n\,30),drawbox=color=blue:t=fill:enable=gte(n\,30)*lt(n\,45),drawbox=color=yellow:t=fill:enable=gte(n\,45)' -c:v libx264 -bf 0 video.mp4
ffmpeg -f lavfi -i 'aevalsrc=0.03*sin(2*PI*440*t)+0.4*sin(2*PI*2000*t)*gte(t\,0.5)*lt(t\,0.52):s=48000:d=2' -c:a aac audio.m4a
ffmpeg -i video.mp4 -vf 'select=if(lt(t\,0.5)\,not(mod(n\,2))\,1)' -fps_mode vfr -c:v libx264 -bf 0 variable.mp4
# Example +2/0 VFR; replace offsets and video input for the other rows.
ffmpeg -copyts -itsoffset 2 -i variable.mp4 -itsoffset 0 -i audio.m4a -map 0:v:0 -map 1:a:0 -c copy -avoid_negative_ts disabled input.mp4
ffprobe -v error -show_format -show_streams -of json input.mp4
ffprobe -v error -select_streams v:0 -show_packets -show_entries packet=pts,duration -of json input.mp4
ffmpeg -ss 0.1 -i input.mp4 -t 0.6 -c:v libx264 -c:a aac old.mp4
```

## 今回の受入範囲

- video正原点、audio／format原点0、各1streamという既存条件を維持。
- r_frame_rate=30/1、平均15〜30fpsは候補gate。全packetのPTSとdurationの組を整列し、30Hzの1／2tick、起点一致、全隣接区間の厳密連続性、実平均rate一致を証明する。
- EOFは最終PTS＋durationから計算。count/30をVFRへ適用しない。holes、重複、overlap、格子外、3tick、未知、診断予算超過は旧bytesを保持する。
- 候補だけ高精度かつ30で割切れるtime baseを使う。1e9は30で割切れずsource1/30で1frame遅延、AVTBは1/30−1µsで1frame早送りする反例があった。1/1920000000もffmpeg6.1のsettbで実際には1/1919999999へ変換され、fps round=upで1frame遅延した。6.1／7.1／同梱7.0で確認する1/30000000と安全整数PTS範囲に限定する。ns境界の保証はしない。
- 正常な旧出力・元媒体・保存source値・Undo/Redoは保持。既存containの入力tick未満の精度、負原点、別原点組合せ、一般VFRは残件。

自動回帰は`lib/sourceAvClock.regression.test.ts`と`lib/sourceAvClock.test.ts`。system／bundled両方で、source0／.1／1/30、0.5秒および1/30秒境界±1µsの固定色とfull-f32-decode byte slice＋AAC encodeのdecoded PCM全byteを比較する。ブラウザ回帰は`verify-divergent-av-clock.mjs`でCFR/VFRのpreview・selected・stretch・contain、保存／Redoを実操作する。

## 負原点・別原点の追加評価（基準main `f18a2af`、PR93後）

正原点を追加した6ケースは上記と同じ2秒のvideo／48kHz AACをcopy muxした。source0.1〜0.7秒の旧抽出をsystem7.1と同梱7.0で比較した。指定audio offsetと実原点はAAC primingのため異なる。

| 指定video/audio | 実video/audio/format原点 | 旧system／同梱 | 今回の判定 |
| --- | --- | --- | --- |
| 0/0 | 0/0/0 | 両stream正常、pulse .4秒 | 既存正常bytes保持 |
| 0/+2 | 0/1.978/0 | 両方とも18video frames、audio欠落 | 最小の新修復対象 |
| +2/+1 | 2/.978/.978 | system両stream欠落、同梱audio欠落 | 今回未修復 |
| +1/+2 | 1/1.978/1 | 両方ともaudio欠落 | 今回未修復 |
| +2/+2 | 2/1.978/1.978 | 両streamあり、system video開始.033008秒／同梱0、pulse .42秒 | 旧complete判定を保持、今回未修復 |
| +.2/+.1 | .2/.078/.078 | 両streamあり、video開始は上と同じ差、pulse .42秒 | 今回未修復 |

最小再現コマンドは上の`video.mp4`／`audio.m4a`を使い、次のとおり。

```sh
ffmpeg -copyts -i video.mp4 -itsoffset 2 -i audio.m4a -map 0:v:0 -map 1:a:0 -c copy -avoid_negative_ts disabled positive-audio.mp4
ffprobe -v error -show_format -show_streams -of json positive-audio.mp4
ffmpeg -ss 0.1 -i positive-audio.mp4 -t 0.6 -c:v libx264 -c:a aac old.mp4
```

期待sourceは各streamの先頭からの相対区間。全復号PCMにはprimingが残りpulseは約.52秒なので、audioのsource.1〜.7は48kHz stereo f32の4800〜33599 sample-frameを固定byte sliceし、同じAAC encoderで再圧縮した結果を参照とする。pulseを元の.5秒へ合わせるoffset fitやpriming除去はしない。videoはsource.5が最初の色境界（上の4色素材では赤→緑、自動回帰の2色素材では赤→青）。0/.1/1/30および.5±1µsを検証する。

修復はMP4系container、H264 CFR30 video原点0、format原点0、正audio原点、AAC-LC 48kHz mono／stereo、各1streamだけ。旧outputが明確に不完全な場合に限り、audio packetのstartPTS一致・順序・連続性・1024sample（最終のみ1〜1024）・skip等side data不在から実末尾を測る。古いprobe4はこの例のaudio durationを4秒と過大報告するが、packet末尾では2.021333秒となる。さらに実encoderと同じffmpegで`-xerror`・48kHz復号を行い、apad前にsource開始sample＋要求sample数まで到達したことを`astats`の累計で証明する。packet spanだけでdecoderの実sample数を保証しない。

追加packet診断と復号prefix診断は各5秒／stdout-stderr合計1MiB。候補の30秒／TERM1秒、identity・再probe・原子的採用と旧complete bytes保持は既存のまま。長尺sourceへの先頭復号の費用保証はしない。native／fade音声preview、contain、他codec／rate／VFR、他原点組合せはこの修復の対象外。

負原点は独立したChromium154単体のvideo／音声captureで対照比較した（アプリの拡張子受理を追加しない）。

| 実container／codecと原点video/audio/format | 対照と全decode PCM | ブラウザ単体結果 |
| --- | --- | --- |
| WebM VP9/Opus 0/−.207/−.207 | 対照audio−.007と96000samples全byte一致 | source0/.25/.5でpulse約.5/.25/0。補正不要 |
| MKV H264/AAC 0/−.221/−.221 | 対照audio−.021と97280samples全byte一致 | 初回0ではpulse約.5、source.25のseek後は.05へ早まり、source.5でpulse消失。未修復 |
| 負offset指定MP4 | mux後video/audio原点0 | 実負原点の証拠にならない |
| 負video指定WebM／MKV | 初期packet PTS不明 | 安全な負video時計の証明に使わない |

このため負原点を一律加減算しない。正常なWebMを壊さず、MKVのseek時刻契約は別の残件として保持する。MKV映像には対照と共通で.500秒が赤／.501秒が青というms境界もあり、負audio固有の症状と混同しない。

## 負audio MKVプレビューの限定単位（基準main `2d90244`、PR94後）

次の最小例をsystem7.1／同梱7.0／隔離6.1で調査した。指定audio offset −.2秒が、AAC priming込みで実audio／format原点−.221秒となる。video原点は0。全復号PCMの先頭をsource0とし、primingを削除しない。

```sh
ffmpeg -f lavfi -i 'color=red:s=64x64:r=30:d=2' -f lavfi -i 'aevalsrc=0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*gte(t\,0.5)*lt(t\,0.52):s=48000:d=2' -af 'asetpts=PTS-0.2/TB' -c:v libx264 -bf 0 -c:a aac -fps_mode passthrough -avoid_negative_ts disabled negative.mkv
ffmpeg -i negative.mkv -map 0:a:0 -vn -c:a copy -bsf:a 'setts=time_base=1/48000:pts=N*1024:dts=N*1024:duration=1024' -movie_timescale 48000 normalized.m4a
```

| source開始 | 元MKVをseek後のpulse（再生から） | `max(0, source−.221)`補正 | 正規化M4Aのpulse（再生から） |
| --- | --- | --- | --- |
| 0 | 約.52秒 | 約.52秒 | 約.52秒 |
| .05 | .25秒 | .52秒 | .47秒 |
| .1 | .20秒 | .52秒 | .42秒 |
| .2 | .10秒 | .52秒 | .32秒 |
| .25 | .05秒 | .27秒 | .27秒 |
| .5 | 消失 | .02秒 | .02秒 |

単純offsetは早いsource区間を回復できない。AAC packet copyは3encoderそれぞれで元媒体と全97,280 sample-frameのstereo f32 PCMが一致し、95packetのpayload hashも一致した。単純copyにはduration末尾24samplesの差が残るため採用しない。候補はpacket時計・durationを1/48000上の1024samples格子へ揃える。古いprobe4はmovie timescale1000のdurationを97296samplesへ丸めるため、movie timescaleも48000にして、厳密97280samplesを再probe・全packet・全復号frameから証明する。

対象は実ファイル4MiB以下、format duration5秒以下、H264／CFR30／video0／time base1/1000、AAC-LC 48k mono/stereo／time base1/1000、audio／format負原点一致（−2秒以上、−.05秒未満）、各1stream。全audio packetはfirstPTS一致、1024sampleのms量子化格子から1tick以内、duration21ms、DTS=PTS、skip等side dataなし、240packet以下が必要。1秒gapの反例は全PCM/payload一致でも失敗とする。全復号frameを1024samples×stereo-f32の8192bytesで確認し、順序付きSHA256を比較する。候補のaudio EOFが元containerのsource末尾を少なくとも1ms超えて覆うことも必要で、短いaudioへのseek後先頭巻戻りを追加しない。読み終わりまでinput identityを再検証し一時候補は清掃する。

製品では原streamを置換しない。任意の補助POSTは、証明済み完成M4Aだけを最大1MiBで返し、対象外は204。プレビューownerが明示Play前に参照MKVを最大8件順次準備し、全完了後にだけBlob URLを一括採用する。原URLと派生のRange混在は起こさない。native／fadeは同じURL resolverを使い、後続partの別assetも準備してから公開時計を開始する。停止・exact seek・非表示時の準備中断・epoch交換はabort／世代を進め、遅い結果の公開・再開を防ぐ。失敗時は原URL固定、メモリURLは不要時と交換／unmountでrevokeする。9件目以降・再生中追加の未準備assetは原経路を保つ。

補助processは各5秒／stdout-stderr合計1MiB／TERM猶予1秒。サーバーは同時2candidateと8identity分最大8MiBを保持し、入力差替えをstat identityで除外する。クライアントも最大8Blob（各1MiB）で、準備中の公開前URLも中断時に清掃する。これは短尺の限定診断で、長尺・大容量・4Kの費用保証ではない。

回帰は`negativeMkvAudio.{test,flow.test,regression.test}.ts`、`previewAudioSources.test.ts`、`previewAudioRoute.test.ts`と`verify-negative-mkv-audio.mjs`。ブラウザ録音の最初の非ゼロを時刻0と推定しない。負Opusではsource.1の最初の非ゼロがmedia約.2秒からでもpulseはmedia約.5秒に正しくあるため、pulse時のmedia時計を既知.5（Opus）／.52（AAC）と比較する。capture開始後のpulse窓・onsetも診断に残す。正常WebM／MP4／AAC primingだけのMKVは元bytesを保持する。

一般VFR・他codec/rate・不明metadata・他原点・negative videoは未修復。ChromiumのEOF約1µs前からの`play()`が先頭へ戻る一般挙動も別残件で、今回のfixtureの合法source末尾は派生EOFより前にある。書き出し／containの負原点全般を修復したものではなく、#72はOPENのまま。

## 長尺の再評価とselected音声欠落検知（基準main `b52011e`、PR96後）

短尺MKVの制限を拡大せず、64×64／H264 CFR30・48kHz AACの60／240／300／420／480秒をsource .1〜.7で比較した。

| 原点video/audio | 結果・確認範囲 |
| --- | --- |
| 0/0 | 全長さで旧AV両stream正常、旧bytes保持 |
| 0/+2秒 | 60／240秒は既存修復成功。300／420／480秒は全audio packet診断が1MiBを超え、video-onlyの旧出力が成功公開される（system7／同梱7+probe4） |
| +2秒/0 | 420秒までは既存修復成功。480秒は全video packet診断が1MiBを超え、既存の映像欠落エラーとなる |

この素材のaudio診断は285秒で1,044,983bytes、286秒で1,048,696bytes。videoは454秒で1,046,736bytes、455秒で1,049,046bytes。PTS桁数／packet数に依存する境界であり、普遍的な時間閾値ではない。実測probe .14〜.27秒で、原因は5秒timeoutではなく出力量。予算は引き上げない。

次の限定対処は長尺の音声修復ではない。selected API（単一動画partの素材DL）の抽出後・公開前だけ、出力が既知H264映像1streamで要求durationを覆い、audioが存在しない場合を調べる。既存の厳密positive-audio MP4 familyと両streamのmetadata被覆に加え、実復号／48kHz化した先頭から必要sampleまでの被覆と連続PTSを証明する。`astats`累計だけでは1秒gapを跨いで必要数へ届く反例があるため、各frameのPTSが直前までの累計samplesと一致し、先頭PTSも0であることを必要とする。paddingやasync resamplingは使わない。

抽出前の入力identityと判定後の入力／出力identityが安定している場合だけ、このジョブの未公開MP4を削除し、音声欠落をエラー表示する。ジョブディレクトリや元素材は削除しない。download／streamは既存のdone条件により409となる。清掃不明／削除失敗を成功へ戻さない。共有extractEditorSegment／compositionには適用せず、gain0の正常出力を保持する。multipart選択はexport-composition経路なので今回の検知対象外。

各追加probe／prefix復号は既存5秒・stdout/stderr合計1MiB・TERM1秒。通常出力にも追加output probeがあり、欠落候補だけsource probeと必要prefix復号が加わる。300秒素材の早期prefixは33frames／33,600samples／3,024bytes、独立6.1／system7／同梱7で0.02〜.09秒だったが一般性能保証ではない。400秒位置は1.82MBとなり未判定へ戻る。長尺後半の欠落修復は残る。

正常AV出力、音声なし入力、短いaudio、PTS gap、未知metadata、診断失敗／予算超過、identity変更は従来bytes／成功を保持する。実無音AACは保持すべき音声trackなので、明確なtrack欠落は検知対象とする。保存DTO／source値／Undo/Redoは変更しない。

自動回帰は`selectedSegmentAudio.{test,regression.test}.ts`、selected routeの非同期job test、`verify-selected-audio-loss.mjs`。検証済み早期区間だけの欠落検知であり、音声復元・一般VFR・他原点／形式・全長尺の解決とは扱わず、#72はOPENを維持する。
