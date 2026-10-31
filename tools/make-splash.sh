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
  "375 667 2 20 iPhone SE 2nd/3rd gen, 6, 6s, 7, 8"
  "414 736 3 20 iPhone 6+, 6s+, 7+, 8+"
  "375 812 3 44 iPhone X, XS, 11 Pro, 12 mini, 13 mini"
  "414 896 2 48 iPhone XR, 11"
  "414 896 3 44 iPhone XS Max, 11 Pro Max"
  "390 844 3 47 iPhone 12, 12 Pro, 13, 13 Pro, 14"
  "428 926 3 47 iPhone 12 Pro Max, 13 Pro Max, 14 Plus"
  "393 852 3 59 iPhone 14 Pro, 15, 15 Pro, 16, 16e"
  "430 932 3 59 iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus"
  "402 874 3 62 iPhone 16 Pro, 17, 17 Pro"
  "440 956 3 62 iPhone 16 Pro Max, 17 Pro Max"
  "420 912 3 62 iPhone Air"
)

page() { # page <css-w> <css-h> <scheme>
  local W=$1 H=$2 INSET=$3
  # The launch image IS the app's first frame: the ink masthead at the top and
  # cream below it, and nothing else. No centred logo, no wordmark, no tagline.
  #
  # That is the whole point. The old image drew a lockup the app then replaced
  # with a different one -- measured, the mark jumped 4.6px and the type grew
  # 4% at the cut, because this file does integer bash maths with
  # line-height:normal and the stylesheet does calc() with line-height 1.35.
  # There is no lockup now, so there is nothing to drift. Keep this in step
  # with .brand in index.html; it is the only coupling left in the launch path.
  local BG="#ece8e1" FG="#17150f"
  local BAND=$(( INSET + 60 ))
  local SIDE=$(( W > 680 ? (W - 640) / 2 : 20 ))

  cat <<HTML
<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#ff00ff;}
  body{display:flex;align-items:center;justify-content:center;}
  .canvas{
    width:${W}px;height:${H}px;background:${BG};
    position:relative;overflow:hidden;
  }
  /* Not a band any more -- the same cream as the page. An ink bar across the
     top was tried and read as something bolted on: "it makes the app locky off
     and not good lookig". This is just where the header sits. */
  .band{
    position:absolute;top:0;left:0;right:0;height:${BAND}px;background:${BG};
    display:flex;align-items:flex-end;justify-content:space-between;
    padding:0 ${SIDE}px 8px ${SIDE}px;box-sizing:border-box;
  }
  .left{display:flex;align-items:center;gap:12px;height:44px;}
  svg.mk{width:34px;height:34px;display:block;border-radius:8px;}
  .word{
    font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;
    font-weight:600;font-size:17px;letter-spacing:-.01em;color:${FG};white-space:nowrap;
    line-height:1.35;
  }
  .gear{width:44px;height:44px;display:flex;align-items:center;justify-content:center;
        margin-right:-11px;}
  .gear svg{width:16px;height:16px;display:block;}
</style></head><body>
<div class="canvas">
  <div class="band">
    <div class="left">
      <!-- Same geometry as icon-512.png, knocked out of the ink instead of
           plated in amber. Keep in step with .brand-mark in index.html. -->
      <svg class="mk" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFCB00"/><stop offset="1" stop-color="#FF9501"/></linearGradient></defs><rect width="512" height="512" rx="113" fill="url(#g)"/><g fill="#fff"><circle cx="178.85" cy="136.8" r="30.0"/><circle cx="332.25" cy="136.8" r="30.0"/><rect x="62.8" y="183.0" width="385.4" height="24.9" rx="12.45"/><path d="M144.20 207.9 L213.50 207.9 L217.65 286.5 L140.05 286.5 Z"/><path d="M155.80 286.5 L130.30 391.0" stroke="#fff" stroke-width="31.5" stroke-linecap="round" fill="none"/><path d="M201.90 286.5 L227.90 391.0" stroke="#fff" stroke-width="31.5" stroke-linecap="round" fill="none"/><path d="M297.60 207.9 L366.90 207.9 L371.05 286.5 L293.45 286.5 Z"/><path d="M309.20 286.5 L283.70 391.0" stroke="#fff" stroke-width="31.5" stroke-linecap="round" fill="none"/><path d="M355.30 286.5 L380.30 391.0" stroke="#fff" stroke-width="31.5" stroke-linecap="round" fill="none"/></g></svg>
      <div class="word">Fly with Friends</div>
    </div>
    <div class="gear"><svg viewBox="0 0 24 24" fill="none" stroke="#8a8275" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></div>
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
  local orient dev W H DPR INSET NAME iw ih
  # No colour-scheme clause anywhere. iOS cannot consult the system scheme
  # because nothing in the list asks about it -- which is what stops the launch
  # image and the app ever disagreeing. Flat filenames too: there is only one
  # set now, and the rename guarantees iOS fetches the new art rather than
  # serving the old one from its launch-image cache.
  for orient in portrait landscape; do
    echo "<!-- $orient -->"
    for dev in "${DEVICES[@]}"; do
      read -r W H DPR INSET NAME <<< "$dev"
      if [ "$orient" = portrait ]; then iw=$(( W * DPR )); ih=$(( H * DPR ));
      else iw=$(( H * DPR )); ih=$(( W * DPR )); fi
      printf '<link rel="apple-touch-startup-image" href="splash/%sx%s.png" media="(device-width: %spx) and (device-height: %spx) and (-webkit-device-pixel-ratio: %s) and (orientation: %s)"><!-- %s -->\n' \
        "$iw" "$ih" "$W" "$H" "$DPR" "$orient" "$NAME"
    done
  done
}

if [ "${1:-}" = "--links" ]; then links; exit 0; fi

mkdir -p "$OUT"
for dev in "${DEVICES[@]}"; do
  read -r W H DPR INSET NAME <<< "$dev"
  pw=$(( W * DPR )); ph=$(( H * DPR ))
  echo "  ${pw}x${ph}  portrait   $NAME"
  render "$W" "$H" "$DPR" "$INSET" "$OUT/${pw}x${ph}.png"
  # iOS reports a top inset of 0 in landscape on all of these, so the band is
  # the bare 60 there rather than inset + 60.
  echo "  ${ph}x${pw}  landscape  $NAME"
  render "$H" "$W" "$DPR" 0 "$OUT/${ph}x${pw}.png"
done
echo
echo "$(ls -1 "$OUT" | wc -l | tr -d ' ') images in $OUT/"
