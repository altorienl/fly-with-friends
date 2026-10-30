#!/bin/bash
# Generates the iOS launch images in splash/ and prints the matching
# <link rel="apple-touch-startup-image"> block to stdout.
#
#   tools/make-splash.sh            # regenerate everything
#   tools/make-splash.sh --links    # print the <link> block only
#
# apple-touch-startup-image is the only launch-screen mechanism iOS honours --
# the web app manifest cannot do it -- and iOS only uses an image whose media
# query matches the device exactly, so there is one file per logical size,
# orientation and colour scheme. Anything unmatched launches to white.
#
# Rendering: the artwork is laid out in a box of exactly W x H CSS px and
# screenshotted at the device's own scale factor, so the mark is drawn once at
# the final pixel size rather than scaled up from a small render. macOS clamps
# a Chrome window to ~500x765 CSS px, so the box is centred in a larger window
# and cropped back out with sips rather than trusted to fill the viewport.
set -u
cd "$(dirname "$0")/.." || exit 1

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT=splash
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# logical-width logical-height dpr  devices
DEVICES=(
  "375 667 2 iPhone SE 2nd/3rd gen, 6, 6s, 7, 8"
  "414 736 3 iPhone 6+, 6s+, 7+, 8+"
  "375 812 3 iPhone X, XS, 11 Pro, 12 mini, 13 mini"
  "414 896 2 iPhone XR, 11"
  "414 896 3 iPhone XS Max, 11 Pro Max"
  "390 844 3 iPhone 12, 12 Pro, 13, 13 Pro, 14"
  "428 926 3 iPhone 12 Pro Max, 13 Pro Max, 14 Plus"
  "393 852 3 iPhone 14 Pro, 15, 15 Pro, 16, 16e"
  "430 932 3 iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus"
  "402 874 3 iPhone 16 Pro, 17, 17 Pro"
  "440 956 3 iPhone 16 Pro Max, 17 Pro Max"
  "420 912 3 iPhone Air"
)

page() { # page <css-w> <css-h> <scheme>
  local W=$1 H=$2 SCHEME=$3
  local BG FG DIM GLOW
  if [ "$SCHEME" = light ]; then
    BG="#ece8e1"; FG="#1b1813"; DIM="#534c40"; GLOW="rgba(255,174,0,.30)"
  else
    BG="#0f0d0a"; FG="#f5f1e9"; DIM="#b2a899"; GLOW="rgba(255,174,0,.20)"
  fi
  # Mark is sized off the short edge so portrait and landscape stay in step.
  local SHORT=$(( W < H ? W : H ))
  local MARK=$(( SHORT * 30 / 100 ))
  [ "$MARK" -gt 190 ] && MARK=190
  local GAP=$(( MARK * 28 / 100 ))
  local WORD=$(( SHORT * 34 / 1000 ))
  [ "$WORD" -lt 11 ] && WORD=11
  [ "$WORD" -gt 15 ] && WORD=15
  local TRACK=$(( WORD * 26 / 100 ))

  cat <<HTML
<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#ff00ff;}
  body{display:flex;align-items:center;justify-content:center;}
  .canvas{
    width:${W}px;height:${H}px;background:${BG};
    position:relative;overflow:hidden;
    display:flex;align-items:center;justify-content:center;
  }
  /* Optical centre, not geometric: the wordmark hangs below the mark, so the
     pair is nudged up to sit where the eye expects the middle. */
  .stack{display:flex;flex-direction:column;align-items:center;
         transform:translateY(-$(( GAP / 2 ))px);}
  /* The field is left flat on purpose. A full-screen radial haze behind the
     mark looked good and cost 350kB a file, because PNG cannot cheaply store a
     thousand-pixel-wide smooth gradient; the warmth lives in the halo below,
     which spans a couple of hundred pixels instead of two thousand. */
  .halo{position:absolute;width:$(( MARK * 3 / 2 ))px;height:$(( MARK * 3 / 2 ))px;
        border-radius:50%;background:radial-gradient(circle,${GLOW} 0%,transparent 70%);
        transform:translateY(-$(( GAP / 2 + MARK / 3 ))px);}
  svg{width:${MARK}px;height:${MARK}px;display:block;position:relative;}
  .word{
    margin-top:${GAP}px;
    font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;
    font-weight:600;font-size:$(( WORD * 15 / 10 ))px;letter-spacing:-.01em;
    color:${FG};white-space:nowrap;
  }
  .sub{
    margin-top:$(( GAP / 2 ))px;
    font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;
    font-size:$(( WORD * 11 / 10 ))px;color:${DIM};letter-spacing:.2px;
  }
</style></head><body>
<div class="canvas">
  <div class="halo"></div>
  <div class="stack">
    <!-- Same geometry as icon-512.png: round-capped strokes so the two
         torsos stay separate instead of fusing. Keep in step with the mark
         in index.html if either changes. -->
    <svg viewBox="0 0 512 512">
      <defs><linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD200"/><stop offset="0.18" stop-color="#FFC800"/><stop offset="1" stop-color="#FF9400"/></linearGradient></defs><rect width="512" height="512" rx="114" fill="url(#bg1)"/><g fill="#fff"><circle cx="180" cy="139" r="31"/><circle cx="332" cy="139" r="31"/><rect x="68" y="184.5" width="376" height="33" rx="16.5"/><path d="M163.5 200.4 L160.5 277.2 A19.5 19.5 0 1 0 199.5 277.2 L196.5 200.4 A16.5 16.5 0 0 0 163.5 200.4 Z"/><path d="M161.5 272.0 L122.7 391.0 A14.5 14.5 0 0 0 149.9 401.1 L198.0 285.5 A19.5 19.5 0 1 0 161.5 272.0 Z"/><path d="M161.8 285.0 L206.0 400.7 A14.5 14.5 0 0 0 233.4 391.4 L198.7 272.5 A19.5 19.5 0 1 0 161.8 285.0 Z"/><path d="M315.5 200.4 L312.5 277.2 A19.5 19.5 0 1 0 351.5 277.2 L348.5 200.4 A16.5 16.5 0 0 0 315.5 200.4 Z"/><path d="M314.0 285.5 L362.1 401.1 A14.5 14.5 0 0 0 389.3 391.0 L350.5 272.0 A19.5 19.5 0 1 0 314.0 285.5 Z"/><path d="M313.3 272.5 L278.6 391.4 A14.5 14.5 0 0 0 306.0 400.7 L350.2 285.0 A19.5 19.5 0 1 0 313.3 272.5 Z"/></g>
    </svg>
    <div class="word">Fly with Friends</div>
    <div class="sub">Everyone lands together</div>
  </div>
</div>
</body></html>
HTML
}

render() { # render <css-w> <css-h> <dpr> <scheme> <outfile>
  local W=$1 H=$2 DPR=$3 SCHEME=$4 FILE=$5
  # The box is centred in the window and cropped back out, so the window has to
  # exceed it by an even number of pixels -- an odd margin lands the crop half a
  # pixel off and leaves a seam of the magenta backstop down one edge.
  local WINW=$(( W > 520 ? W : 520 ))
  local WINH=$(( H > 800 ? H : 800 ))
  (( (WINW - W) % 2 )) && WINW=$(( WINW + 1 ))
  (( (WINH - H) % 2 )) && WINH=$(( WINH + 1 ))
  page "$W" "$H" "$SCHEME" > "$WORK/p.html"
  "$CHROME" --headless --disable-gpu --no-sandbox \
    --virtual-time-budget=20000 --hide-scrollbars \
    --window-size="$WINW,$WINH" --force-device-scale-factor="$DPR" \
    --screenshot="$WORK/raw.png" "file://$WORK/p.html" 2>/dev/null
  sips -c $(( H * DPR )) $(( W * DPR )) "$WORK/raw.png" --out "$WORK/cropped.png" >/dev/null 2>&1
  # A launch image is a flat field, one gradient tile and two lines of text. In
  # truecolour PNG that still costs six figures of bytes; on an adaptive palette
  # it costs four, with no visible difference at 3x.
  python3 - "$WORK/cropped.png" "$FILE" <<'PY'
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
im.quantize(colors=128, method=Image.MEDIANCUT,
            dither=Image.FLOYDSTEINBERG).save(dst, optimize=True)
PY
}

links() {
  cat <<'HEAD'
<!-- iOS launch screens. apple-touch-startup-image is the only mechanism iOS honours
     for this; the web app manifest cannot do it. iOS uses an image only when its
     media query matches the device exactly, so there is one file per logical size
     and orientation, and anything unmatched launches to a bare white screen.
     device-width/device-height are always the portrait values -- they do not swap
     when the phone turns -- so orientation is what separates the two halves.
     The dark images carry no colour-scheme clause, so one of them always matches;
     the light ones are listed afterwards and win wherever the scheme query is
     understood. Regenerate both the files and this block with tools/make-splash.sh. -->
HEAD
  local scheme orient dev W H DPR NAME suffix iw ih
  for scheme in dark light; do
    if [ "$scheme" = light ]; then suffix=' and (prefers-color-scheme: light)'; else suffix=''; fi
    for orient in portrait landscape; do
      echo "<!-- $scheme, $orient -->"
      for dev in "${DEVICES[@]}"; do
        read -r W H DPR NAME <<< "$dev"
        if [ "$orient" = portrait ]; then iw=$(( W * DPR )); ih=$(( H * DPR ));
        else iw=$(( H * DPR )); ih=$(( W * DPR )); fi
        printf '<link rel="apple-touch-startup-image" href="splash/%s-%sx%s.png" media="(device-width: %spx) and (device-height: %spx) and (-webkit-device-pixel-ratio: %s) and (orientation: %s)%s"><!-- %s -->\n' \
          "$scheme" "$iw" "$ih" "$W" "$H" "$DPR" "$orient" "$suffix" "$NAME"
      done
    done
  done
}

if [ "${1:-}" = "--links" ]; then links; exit 0; fi

mkdir -p "$OUT"
for scheme in dark light; do
  for dev in "${DEVICES[@]}"; do
    read -r W H DPR NAME <<< "$dev"
    pw=$(( W * DPR )); ph=$(( H * DPR ))
    echo "  $scheme  ${pw}x${ph}  portrait   $NAME"
    render "$W" "$H" "$DPR" "$scheme" "$OUT/$scheme-${pw}x${ph}.png"
    echo "  $scheme  ${ph}x${pw}  landscape  $NAME"
    render "$H" "$W" "$DPR" "$scheme" "$OUT/$scheme-${ph}x${pw}.png"
  done
done
echo
echo "$(ls -1 "$OUT" | wc -l | tr -d ' ') images in $OUT/"
