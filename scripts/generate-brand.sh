#!/usr/bin/env bash
# Derive every branded asset from the source artwork, assets/local-acp-2.png.
#
# That file is a 823x298 lockup on a white ground: a circular badge at
# x66-250 / y79-264, and the "LocalACP" logotype at x296-743 / y77-153. Both
# are cut out here rather than by hand so the crop boxes, the transparency
# recovery and the icon sizes are all reproducible from one command.
#
# Outputs (all committed, so `tauri build` never needs ImageMagick):
#   assets/brand/localacp-mark.png      - circular badge, transparent
#   assets/brand/localacp-wordmark.png  - logotype, transparent
#   src-tauri/icons/**                  - every platform app-icon size
#
# Requires ImageMagick (`brew install imagemagick`).
set -euo pipefail

cd "$(dirname "$0")/.."

command -v magick >/dev/null || {
  echo "error: ImageMagick (magick) is required. brew install imagemagick" >&2
  exit 1
}

src="assets/local-acp-2.png"
out="assets/brand"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

mkdir -p "$out"

# The source has an opaque white ground and a stray 2px grey rule down its
# right edge; flattening onto white and cropping by measured box drops both.
magick "$src" -background white -flatten "$staging/flat.png"

# --- Badge -----------------------------------------------------------------
# Masked to its circle rather than colour-keyed: the illustration contains
# white (the shirt), so keying white would punch holes in the character.
#
# The circle's geometry is NOT the bounding box of the badge. The blue
# blueprint the character holds spills past the disc on the right and the hard
# hat reaches its top, so the ink bbox is wider and taller than the disc
# itself; masking to it left a ring of the white ground alive on the diagonals.
# These numbers come from a least-squares fit of 155 left-rim points instead:
# centre (155.54, 174.97), radius 89.68 in the source, max residual 0.56px.
# The mask uses 89.0 so it lands inside the single antialiased rim pixel.
CROP=184           # crop box side, centred on the fitted disc
CROP_X=64          # 155.54 - 91.54
CROP_Y=83          # 174.97 - 91.97
CX=91.54           # disc centre within the crop
CY=91.97
R=89.0             # mask radius within the crop

circle_mask() { # $1 = size, $2 = output
  magick -size "$1x$1" xc:black -fill white \
    -draw "$(awk -v s="$1" -v c="$CROP" -v cx="$CX" -v cy="$CY" -v r="$R" \
      'BEGIN{k=s/c; printf "circle %.2f,%.2f %.2f,%.2f", cx*k, cy*k, cx*k, (cy-r)*k}')" \
    -alpha off "$2"
}

magick "$staging/flat.png" -crop "${CROP}x${CROP}+${CROP_X}+${CROP_Y}" +repage \
  "$staging/badge-sq.png"
circle_mask "$CROP" "$staging/mask-crop.png"
magick "$staging/badge-sq.png" "$staging/mask-crop.png" \
  -alpha off -compose CopyOpacity -composite "$out/localacp-mark.png"

# --- Wordmark --------------------------------------------------------------
# Flat #406897 on white, so alpha inverts exactly: a pixel is
# fg*a + white*(1-a), giving a = (255 - R) / (255 - 64). Recovering it this
# way and re-filling with the flat colour beats a fuzz-based key, which
# leaves a white halo on the dark theme.
magick "$staging/flat.png" -crop 448x77+296+77 +repage \
  -channel R -separate +channel -negate -level 0%,74.902% "$staging/wm-alpha.png"
magick -size 448x77 xc:"#406897" "$staging/wm-alpha.png" \
  -alpha off -compose CopyOpacity -composite "$out/localacp-wordmark.png"

# --- Application icon ------------------------------------------------------
# The badge is only 186px, so reaching the 1024px `tauri icon` wants is a
# 5.5x upscale. The artwork is flat colour in large regions, which survives
# that far better than a photograph would, and a wide mild unsharp restores
# the edges the interpolation softens without ringing them. The sharpen is
# confined to RGB: run across alpha too it overshoots at the circle's rim and
# rings the whole badge with a pale halo.
# Inset to 86% leaves the margin a macOS icon is expected to have.
# Upscaled with the white ground still attached and masked afterwards, so the
# circle's edge is drawn crisp at 880px instead of being an interpolated 186px
# edge stretched ~4.8x.
# Replace everything outside the disc with the disc's own purple before
# upscaling. Left as white it is a hard purple/white edge for the unsharp to
# overshoot, ringing the finished icon; flooded to purple there is no edge at
# the boundary at all, and the mask below draws the real one.
#
# Done with the disc mask rather than a flood-fill from the corner: the
# character is clipped by the circle, so its white shirt touches the exterior
# white and any fill wide enough to catch the antialiased rim runs straight
# through the shirt and floods the whole figure.
magick -size "${CROP}x${CROP}" xc:"#5C4E85" "$staging/badge-sq.png" \
  "$staging/mask-crop.png" -compose Over -composite "$staging/badge-filled.png"
magick "$staging/badge-filled.png" \
  -filter Lanczos -resize 880x880 -unsharp 0x6+1.0+0.01 "$staging/icon-big.png"
circle_mask 880 "$staging/mask-880.png"
magick "$staging/icon-big.png" "$staging/mask-880.png" \
  -alpha off -compose CopyOpacity -composite "$staging/icon-masked.png"
# Padded in a separate invocation on purpose: chaining -extent onto the
# CopyOpacity above makes ImageMagick adopt the grey mask's colourspace and
# emit a greyscale icon.
magick "$staging/icon-masked.png" -colorspace sRGB \
  -background none -gravity center -extent 1024x1024 "$staging/icon-1024.png"
npx tauri icon "$staging/icon-1024.png"

echo "Regenerated $out and src-tauri/icons from $src"
