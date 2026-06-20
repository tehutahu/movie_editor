#!/bin/bash
set -euo pipefail

#----------------------------------------
# restore_speed.sh
# 任意の倍速動画を元の速度・音程に戻すスクリプト
#
# Usage (ファイル入力):
#   ./restore_speed.sh INPUT_FILE SPEED_FACTOR [OUTPUT_FILE] [SAMPLE_RATE]
#
# Usage (ディレクトリ入力):
#   ./restore_speed.sh INPUT_DIR  SPEED_FACTOR [SAMPLE_RATE]
#
#   INPUT_FILE/INPUT_DIR : 処理対象の動画ファイルまたはディレクトリ
#   SPEED_FACTOR         : 倍速の係数（例: 1.5, 2.0, 0.75）
#   OUTPUT_FILE          : （ファイル入力時のみ）出力ファイル名
#   SAMPLE_RATE          : 音声サンプリングレート [Hz]（デフォルト 44100）
#
# Examples:
#   # 単一ファイルを指定 → 出力名自動生成
#   ./restore_speed.sh fast.mp4 2.0
#
#   # 単一ファイルを指定 → 出力名明示
#   ./restore_speed.sh fast.mp4 1.5 restored.mp4 48000
#
#   # ディレクトリを指定 → その中の .mp4/.mkv/.avi/.mov を一括処理
#   ./restore_speed.sh ./videos 1.75 48000
#----------------------------------------

usage(){
  echo "Usage:" >&2
  echo "  $0 INPUT_FILE SPEED_FACTOR [OUTPUT_FILE] [SAMPLE_RATE]" >&2
  echo "  $0 INPUT_DIR  SPEED_FACTOR [SAMPLE_RATE]" >&2
  exit 1
}

# 引数チェック（最低 2, 最大 4）
if [ $# -lt 2 ] || [ $# -gt 4 ]; then
  usage
fi

INPUT="$1"
SPEED="$2"

# ディレクトリモードかファイルモードか
if [ -d "$INPUT" ]; then
  # ディレクトリモード: 引数は INPUT_DIR, SPEED, [SAMPLE_RATE]
  if [ $# -gt 3 ]; then usage; fi
  SR="${3:-44100}"

  # 動画ファイル拡張子チェック関数
  is_video(){
    case "${1##*.}" in
      mp4|MP4|mkv|MKV|avi|AVI|mov|MOV|flv|FLV|wmv|WMV) return 0;;
      *) return 1;;
    esac
  }

  for f in "$INPUT"/*; do
    [ -e "$f" ] || continue
    if ! is_video "$f"; then continue; fi

    base=$(basename "$f")
    dir=$(dirname  "$f")
    name="${base%.*}"
    ext="${base##*.}"

    OUT="${dir}/${name}_restored_${SPEED}x.${ext}"

    echo "▶ Processing: '$base' → '$(basename "$OUT")'"
    ffmpeg -y -i "$f" \
      -filter_complex "[0:v]setpts=${SPEED}*PTS[v];[0:a]asetrate=${SR}/${SPEED},aresample=${SR}[a]" \
      -map "[v]" -map "[a]" \
      -c:v libx264 -c:a aac -strict experimental \
      "$OUT"
  done

  echo "✅ Directory mode: all videos processed."
  exit 0

else
  # ファイルモード: 引数は INPUT_FILE, SPEED, [OUTPUT_FILE], [SAMPLE_RATE]
  if [ $# -eq 2 ]; then
    # 出力名・SRともデフォルト
    OUT=""
    SR="44100"
  elif [ $# -eq 3 ]; then
    # 第３引数が数字なら SR、文字列なら OUTPUT_FILE
    if [[ "$3" =~ ^[0-9]+$ ]]; then
      OUT=""
      SR="$3"
    else
      OUT="$3"
      SR="44100"
    fi
  else
    # $# -eq 4
    OUT="$3"
    SR="$4"
  fi

  # 出力名自動生成
  if [ -z "$OUT" ]; then
    base=$(basename "$INPUT")
    dir=$(dirname  "$INPUT")
    name="${base%.*}"
    ext="${base##*.}"
    OUT="${dir}/${name}_restored_${SPEED}x.${ext}"
  fi

  echo "▶ Processing: '$(basename "$INPUT")' → '$(basename "$OUT")'"
  ffmpeg -y -i "$INPUT" \
    -filter_complex "[0:v]setpts=${SPEED}*PTS[v];[0:a]asetrate=${SR}/${SPEED},aresample=${SR}[a]" \
    -map "[v]" -map "[a]" \
    -c:v libx264 -c:a aac -strict experimental \
    "$OUT"

  echo "✅ Done: '$OUT'"
  exit 0
fi

