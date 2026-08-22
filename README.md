# Clipnote.js

A small browser player for Clipnotestudio `.clip` files and CNS animation files.
It provides two custom HTML elements:

- `clipnote-image` displays one thumbnail.
- `clipnote-player` displays and plays an animation.

The code runs in the browser. It needs `clipnote.js` and JSZip for `.clip` archives.

## Basic Setup

Load JSZip before `clipnote.js`:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<script src="clipnote.js"></script>
```

The player assets are loaded relative to the page:

```text
img/bg.png
img/loading.gif
img/playerbottom1.png
img/playerbottom2.png
img/playericon1.png
img/playericon2.png
img/playerthingy.png
img/volume1.png
img/volume2.png
```
## Thumbnail Element

Use `clipnote-image` for a single still image. The `thumbnailFrame` stored in a CNS file is used automatically. `.clip` files use their `thumb.png` entry.

```html
<clipnote-image
  url="path/to/animation.cns"
  width="320"
  height="240"
  scaling="auto">
</clipnote-image>
```

## Animation Element

Use `clipnote-player` for a playable animation:

```html
<clipnote-player
  url="path/to/animation.clip"
  width="640"
  height="480"
  scaling="auto">
</clipnote-player>
```

Both elements support `.clip` and `.cns` files. The player creates its own canvas, controls, audio element, loading overlay, and transparency background.

## Attributes

| Attribute | Values | Description |
|---|---|---|
| `url` | file URL | Required. URL of a `.clip` or `.cns` file. |
| `width` | CSS length or number | Requested player width. The player keeps a 4:3 aspect ratio. |
| `height` | CSS length or number | Requested height. Responsive CSS width is recommended. |
| `scaling` | `auto`, `integer`, `pixelated`, `smooth` | Controls image filtering. Defaults to `auto`. |
| `autoplay` | empty attribute | Starts animation and audio after loading. Browser autoplay policy may still require user interaction for audio. |
| `menu-image` | image URL | Replaces the menu sprite shown before the controls are opened. |

## Scaling Modes

`scaling="auto"` is the default. It uses nearest-neighbor rendering when the displayed player is an exact integer multiple of `320x240`, and normal browser filtering at fractional sizes.

```html
<clipnote-player url="note.cns" width="640" height="480" scaling="auto"></clipnote-player>
```

`scaling="integer"` always uses nearest-neighbor rendering. Use this when the player should keep hard pixel edges.

```html
<clipnote-player url="note.cns" width="960" height="720" scaling="integer"></clipnote-player>
```

`scaling="pixelated"` is an alias for forced nearest-neighbor rendering, including fractional sizes.

`scaling="smooth"` always uses normal filtered browser scaling. Use this when the player is not an integer multiple of `320x240` and should avoid jagged enlargement.

```html
<clipnote-image url="note.cns" width="500" height="375" scaling="smooth"></clipnote-image>
```

The same setting applies to `clipnote-image` and `clipnote-player`.

## Player Controls

The native player interface provides:

- Play and pause
- Timeline scrubbing
- Volume adjustment
- Mute and unmute
- Menu button to reveal or hide controls
- Automatic control hiding after inactivity
- Outside-click control dismissal
- Keyboard shortcuts when the player is fully visible:
  - `Space`: play or pause
  - `M`: mute or unmute
  - `Left Arrow`: previous frame
  - `Right Arrow`: next frame

Non-looping files hold on their last frame. Pressing play again from the last frame starts over at frame 0. Looping files restart at frame 0.

## Loading State

Every player shows a loading overlay while it fetches and decodes the file. The overlay uses `img/loading.gif` and the transparency grid from `img/bg.png`.

## JavaScript API

`clipnote.js` exposes these globals:

```js
window.CNS
window.ClipnotePlayer
```

### `ClipnotePlayer.parseFile(source)`

Parses a `.cns` or `.clip` `File`, `Blob`, or binary source without creating a
player element. The result includes `format`, `thumbnail`, and format-specific
parsed data. This is the parser used by the included folder playlist.

```js
const parsed = await ClipnotePlayer.parseFile(file);

if (parsed.format === 'cns') {
  console.log(parsed.cns.frameCount);
  console.log(parsed.cns.thumbnailFrame);
} else {
  console.log(parsed.clipMeta.data.framerate);
  console.log(parsed.clipMeta.user.name);
}
document.body.append(parsed.thumbnail);
```

For CNS files, `parsed.cns` is the complete CNS parser result and
`parsed.thumbnail` is rendered from its declared `thumbnailFrame`. For CLIP
files, `parsed.clipMeta` contains every parsed `data.ini` section and
`parsed.thumbnail` is the archive's `thumb.png` when present.

Normally, creating the HTML element is enough. To control it directly:

```js
const element = document.querySelector('clipnote-player');
const player = new ClipnotePlayer(element);

player.ready
  .then(() => console.log('player loaded'))
  .catch((error) => console.error(error));
```

### `player.ready`

A Promise that resolves after the file has been fetched, parsed, decoded, and rendered. It rejects if loading fails.

### `player.destroy()`

Stops animation, pauses and releases audio, removes document event listeners, disconnects resizing observers, and clears decoded frame resources. Call it before removing or replacing a player.

```js
player.destroy();
```

### Playback and UI methods

```js
player.togglePlay();
player.toggleMute();
player.startPlayback();
player.updateFrame();
player.scrubFrame(-1);
player.scrubFrame(1);
player.updateVolume();
player.showControls();
player.showControlsWithSpring();
player.hideControls();
player.hideControlsWithSpring();
```

Most applications should use the built-in controls instead of calling these methods directly.

Useful runtime properties include:

```js
player.isPlaying;
player.currentFrame;
player.frames;
player.framerate;
player.loop;
player.sound;
player.canvas;
player.cnsMeta;
player.palette;
player.clipMeta;
```

### Parsed `.clip` metadata

For `.clip` files, `player.clipMeta` contains every section and key from the
archive's `data.ini`, with quoted values already unwrapped. For example:

```js
await player.ready;

console.log(player.clipMeta.data.framerate);
console.log(player.clipMeta.data.frame_max);
console.log(player.clipMeta.data.replay);
console.log(player.clipMeta.user.name);
console.log(player.clipMeta.user.id);
```

The player also exposes commonly used playback values directly:

```js
player.framerate;
player.frameMax;
player.frameCount;
player.loop;
```

`clipMeta` is available on both `clipnote-player` and `clipnote-image` when the
`.clip` archive contains `data.ini`. Unknown sections and keys are preserved,
so metadata added by newer tools remains accessible.

### Changing the CNS palette

Use `player.setPalette()` to change the six CNS colors at runtime. The change
is intentionally applied as a reload: the current player is destroyed, the
file is fetched and decoded again, and the loading overlay is shown while the
new palette is rendered. This is supported for CNS files; `.clip` image data
is already baked into its PNG layers and is not recolored by this method.

Pass colors as `#rrggbb` strings or `[red, green, blue]` arrays. Palette
indexes are `0` white, `1` black, `2` red, `3` yellow, `4` green, and `5` blue.
You can change only selected indexes; omitted colors keep their current values.

```js
await player.setPalette({
  0: '#101820',
  1: '#f2f0e6',
  2: [255, 120, 80],
});
```

`setPalette()` returns the new `ready` Promise. The player keeps using its
current URL and preserves the `autoplay` attribute behavior after the reload.

The parser helpers used by the player are also available directly:

```js
const palette = CNS.getPalette();
const customPalette = CNS.createPalette({ 1: '#202020' }, palette);
const image = CNS.buildFrameCanvas(cnsFile, 0, customPalette);
```

## CNS Parser API

The `CNS` global can parse a CNS ArrayBuffer and render frames:

```js
const response = await fetch('note.cns');
const cnsFile = await CNS.parse(await response.arrayBuffer());
const frameCanvas = CNS.buildFrameCanvas(cnsFile, cnsFile.thumbnailFrame);
document.body.append(frameCanvas);
```

Available parser functions:

```js
CNS.parse(arrayBuffer);
CNS.buildFrameCanvas(cnsFile, frameIndex);
CNS.buildLayerCanvas(tileDictionary, layerGrid);
CNS.decodeLayerIndices(tileDictionary, layer);
CNS.indicesToImageData(indices);
```

Parser constants are also available:

```js
CNS.WIDTH;       // 320
CNS.HEIGHT;      // 240
CNS.PALETTE;     // CNS palette colors
CNS.TRANSPARENT; // 6
```

CNS frame data supports 1-byte, 2-byte, and 4-byte tile indexes. Large CNS dictionaries therefore work in both the parser and player.

## CNS Audio

CNS audio is stored in the optional `AUD1` chunk as Ogg data. The player creates an `Audio` element for it automatically and keeps it synchronized with frame playback.

```js
if (player.sound) {
  player.sound.volume = 0.5;
  player.sound.muted = false;
}
```

## Live demo
[https://mtboss124.github.io/Clipnote.js/]
<img width="1102" height="957" alt="image" src="https://github.com/user-attachments/assets/0cc5e1ce-1bc3-4553-84db-af37a1261a3c" />

## Credits

- Coding: mtboss124
- Clipnote Studio: Cal
- Flipnote.js inspiration and reference: James
