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
