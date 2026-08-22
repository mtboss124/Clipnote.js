
const CNS = (() => {
    const MAGIC = [0x43, 0x4E, 0x53]; // "CNS"
    const VERSION = 2; // v2 adds thumbnail_frame to HDR1
    const WIDTH = 320, HEIGHT = 240;
    const TILE = 8;
    const TILES_X = WIDTH / TILE;    // 40
    const TILES_Y = HEIGHT / TILE;   // 30
    const TILE_COUNT = TILES_X * TILES_Y; // 1200
    const LAYER_COUNT = 3;
    const TRANSPARENT = 6;

    // index -> [r, g, b]; index 6 (transparent) has no entry
    const PALETTE = {
        0: [0xff, 0xff, 0xff], // white
        1: [0x14, 0x14, 0x14], // black
        2: [0xff, 0x17, 0x17], // red
        3: [0xff, 0xe6, 0x00], // yellow
        4: [0x00, 0x82, 0x32], // green
        5: [0x06, 0xae, 0xff], // blue
    };

    async function inflateZlib(bytes) {
        const ds = new DecompressionStream('deflate');
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    function readUint16LE(view, offset) {
        return view[offset] | (view[offset + 1] << 8);
    }

    function readUint32LE(view, offset) {
        return (
            (view[offset] |
                (view[offset + 1] << 8) |
                (view[offset + 2] << 16) |
                (view[offset + 3] << 24)) >>> 0
        );
    }

    function readString(view, offset) {
        const len = readUint16LE(view, offset);
        offset += 2;
        const strBytes = view.subarray(offset, offset + len);
        const str = new TextDecoder('utf-8').decode(strBytes);
        offset += len;
        return [str, offset];
    }

    function rleDecode(bytes) {
        const pixels = [];
        for (let i = 0; i < bytes.length; i += 2) {
            const run = bytes[i];
            const val = bytes[i + 1];
            for (let k = 0; k < run; k++) pixels.push(val);
        }
        return pixels;
    }

    function readChunks(bytes) {
        const chunks = {};
        let offset = 5; // 3-byte magic + 2-byte version
        while (offset < bytes.length) {
            const id = String.fromCharCode(
                bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]
            );
            offset += 4;
            const length = readUint32LE(bytes, offset);
            offset += 4;
            chunks[id] = bytes.subarray(offset, offset + length);
            offset += length;
        }
        return chunks;
    }

    async function parse(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2]) {
            throw new Error('CNS: not a CNS file (bad magic)');
        }
        const version = readUint16LE(bytes, 3);

        const chunks = readChunks(bytes);
        const hdr = chunks['HDR1'];

        let o = 0;
        const framerate = hdr[o]; o += 1;
        const frameMax = readUint32LE(hdr, o); o += 4;
        const thumbnailFrame = readUint32LE(hdr, o); o += 4;
        const replay = hdr[o]; o += 1;
        const locked = hdr[o]; o += 1;
        let fileId; [fileId, o] = readString(hdr, o);
        const spinoff = hdr[o]; o += 1;
        let spinoffSourceFileId; [spinoffSourceFileId, o] = readString(hdr, o);
        let originalUserName; [originalUserName, o] = readString(hdr, o);
        let originalUserId; [originalUserId, o] = readString(hdr, o);
        const hasAudio = hdr[o]; o += 1;
        const dictTileCount = readUint32LE(hdr, o); o += 4;
        let userName; [userName, o] = readString(hdr, o);
        let userId; [userId, o] = readString(hdr, o);

        //tile dictionary
        const tdicRaw = await inflateZlib(chunks['TDIC']);
        const tileDict = [];
        {
            let off = 0;
            for (let i = 0; i < dictTileCount; i++) {
                const rleLen = readUint16LE(tdicRaw, off); off += 2;
                const rle = tdicRaw.subarray(off, off + rleLen); off += rleLen;
                tileDict.push(rleDecode(rle));
            }
        }

        //per-frame, per-layer tile-index grids
        const frameCount = frameMax + 1;
        const indexWidth = dictTileCount <= 255 ? 1 : 2;
        const frmsRaw = await inflateZlib(chunks['FRMS']);
        const frames = [];
        {
            let off = 0;
            for (let f = 0; f < frameCount; f++) {
                const layers = [];
                for (let l = 0; l < LAYER_COUNT; l++) {
                    const visible = !!frmsRaw[off]; off += 1;
                    const emptyFlag = frmsRaw[off]; off += 1;
                    if (emptyFlag) {
                        layers.push({ visible, grid: null });
                    } else {
                        const grid = new Array(TILE_COUNT);
                        for (let t = 0; t < TILE_COUNT; t++) {
                            if (indexWidth === 1) {
                                grid[t] = frmsRaw[off]; off += 1;
                            } else {
                                grid[t] = frmsRaw[off] | (frmsRaw[off + 1] << 8); off += 2;
                            }
                        }
                        layers.push({ visible, grid });
                    }
                }
                frames.push(layers);
            }
        }

        const audioBytes = hasAudio && chunks['AUD1'] ? chunks['AUD1'] : null;

        return {
            framerate, frameMax, frameCount, thumbnailFrame, replay, locked,
            fileId, spinoff, spinoffSourceFileId,
            originalUserName, originalUserId,
            userName, userId,
            dictTileCount, tileDict, frames, audioBytes,
        };
    }

    function buildLayerCanvas(tileDict, grid) {
        const canvas = document.createElement('canvas');
        canvas.width = WIDTH;
        canvas.height = HEIGHT;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(WIDTH, HEIGHT);
        const data = imageData.data;

        for (let ty = 0; ty < TILES_Y; ty++) {
            for (let tx = 0; tx < TILES_X; tx++) {
                const pixels = tileDict[grid[ty * TILES_X + tx]];
                const baseX = tx * TILE;
                const baseY = ty * TILE;
                for (let row = 0; row < TILE; row++) {
                    const y = baseY + row;
                    let off = (y * WIDTH + baseX) * 4;
                    for (let col = 0; col < TILE; col++) {
                        const v = pixels[row * TILE + col];
                        if (v === TRANSPARENT) {
                            data[off + 3] = 0;
                        } else {
                            const [r, g, b] = PALETTE[v];
                            data[off] = r;
                            data[off + 1] = g;
                            data[off + 2] = b;
                            data[off + 3] = 255;
                        }
                        off += 4;
                    }
                }
            }
        }

        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    function buildFrameCanvas(cnsFile, frameIndex) {
        const canvas = document.createElement('canvas');
        canvas.width = WIDTH;
        canvas.height = HEIGHT;
        const ctx = canvas.getContext('2d');


        const layers = cnsFile.frames[frameIndex];
        for (let l = 0; l < LAYER_COUNT; l++) {
            const layer = layers[l];
            if (!layer.visible || !layer.grid) continue;
            const layerCanvas = buildLayerCanvas(cnsFile.tileDict, layer.grid);
            ctx.drawImage(layerCanvas, 0, 0);
        }

        return canvas;
    }

    return { parse, buildFrameCanvas, buildLayerCanvas, WIDTH, HEIGHT, PALETTE, TRANSPARENT };
})();

class ClipnotePlayer {
    constructor(element) {
        this.element = element;
        this.url = element.getAttribute('url');
        this.width = element.getAttribute('width') || '320';
        this.height = element.getAttribute('height') || '240';
        this.isImage = element.tagName.toLowerCase() === 'clipnote-image';
        this.menuImage = element.getAttribute('menu-image') || 'img/playerbottom1.png';
        this.init();
    }

    async init() {
        if (!this.url) {
            console.error('ClipnotePlayer: No URL provided');
            return;
        }

        const response = await fetch(this.url);
        const blob = await response.blob();

        if (await this.isCNSFile(blob)) {
            const buffer = await blob.arrayBuffer();
            if (this.isImage) {
                await this.loadThumbnailCNS(buffer);
            } else {
                await this.loadAnimationCNS(buffer);
            }
            return;
        }

        const zip = await JSZip.loadAsync(blob);

        if (this.isImage) {
            this.loadThumbnail(zip);
        } else {
            this.loadAnimation(zip);
        }
    }

    async isCNSFile(blob) {
        const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
        return head[0] === 0x43 && head[1] === 0x4E && head[2] === 0x53; // "C","N","S"
    }

    async loadThumbnailCNS(buffer) {
        const cnsFile = await CNS.parse(buffer);
        // Show whichever frame the file itself designates as its thumbnail,
        // not always frame 0.
        const frameCanvas = CNS.buildFrameCanvas(cnsFile, cnsFile.thumbnailFrame || 0);
        const img = document.createElement('img');
        img.src = frameCanvas.toDataURL('image/png');
        img.width = this.width;
        img.height = this.height;
        this.element.appendChild(img);
    }

    async loadAnimationCNS(buffer) {
        const cnsFile = await CNS.parse(buffer);

        this.framerate = cnsFile.framerate || 12;
        this.loop = cnsFile.replay === 1;
        this.frameMax = cnsFile.frameMax || 0;
        this.thumbnailFrame = cnsFile.thumbnailFrame || 0;

        this.cnsMeta = {
            fileId: cnsFile.fileId,
            locked: cnsFile.locked === 1,
            spinoff: cnsFile.spinoff === 1,
            spinoffSourceFileId: cnsFile.spinoffSourceFileId,
            originalUserName: cnsFile.originalUserName,
            originalUserId: cnsFile.originalUserId,
            userName: cnsFile.userName,
            userId: cnsFile.userId,
            thumbnailFrame: cnsFile.thumbnailFrame,
        };

        this.frames = [];
        for (let i = 0; i < cnsFile.frameCount; i++) {
            this.frames.push(CNS.buildFrameCanvas(cnsFile, i));
        }

        this.sound = this.loadSoundFromCNS(cnsFile);

        this.createPlayerContainer();
        this.createUI();
        this.createCanvas();
        this.setupPlayback();

        // draw first frame (replace thumbnail)
        if (this.frames && this.frames.length > 0) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.drawImage(this.frames[0], 0, 0);
            if (this.thumbnailImage && this.thumbnailImage.parentNode) {
                this.thumbnailImage.parentNode.removeChild(this.thumbnailImage);
                this.thumbnailImage = null;
            }
        }
    }

    loadSoundFromCNS(cnsFile) {
        if (!cnsFile.audioBytes) return null;
        const blob = new Blob([cnsFile.audioBytes], { type: 'audio/ogg' });
        const url = URL.createObjectURL(blob);
        return new Audio(url);
    }

    async loadThumbnail(zip) {
        const thumbBlob = await zip.file('thumb.png').async('blob');
        const thumbUrl = URL.createObjectURL(thumbBlob);
        const img = document.createElement('img');
        img.src = thumbUrl;
        img.width = this.width;
        img.height = this.height;

        this.element.appendChild(img);
    }

    async loadAnimation(zip) {
        const iniData = await zip.file('data.ini').async('text');
        const config = this.parseIni(iniData);
        this.framerate = parseInt(config.data.framerate) || 12;
        this.loop = config.data.replay === '1';
        this.frameMax = parseInt(config.data.frame_max) || 0;

        this.frames = await this.loadFrames(zip, this.frameMax);
        this.sound = await this.loadSound(zip);
        this.createPlayerContainer();
        this.createUI();
        this.createCanvas();
        this.setupPlayback();
                // draw first frame (replace thumbnail)
        if (this.frames && this.frames.length > 0) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.drawImage(this.frames[0], 0, 0);
            // remove thumbnail once we have drawn the first frame
            if (this.thumbnailImage && this.thumbnailImage.parentNode) {
                this.thumbnailImage.parentNode.removeChild(this.thumbnailImage);
                this.thumbnailImage = null;
            }
        }
    }

    parseIni(data) {
        const result = {};
        let section = null;
        data.split('\n').forEach(line => {
            line = line.trim();
            if (line.startsWith('[') && line.endsWith(']')) {
                section = line.slice(1, -1).toLowerCase();
                result[section] = {};
            } else if (section && line.includes('=')) {
                const [key, value] = line.split('=').map(s => s.trim());
                result[section][key] = value.replace(/"/g, '');
            }
        });
        return result;
    }

    async loadFrames(zip, frameMax) {
        const frames = [];
        
        // Batch process frames for better performance
        const batchSize = 10;
        for (let start = 0; start <= frameMax; start += batchSize) {
            const end = Math.min(start + batchSize - 1, frameMax);
            const batchPromises = [];
            
            for (let i = start; i <= end; i++) {
                batchPromises.push(this.loadSingleFrame(zip, i));
            }
            
            const batchFrames = await Promise.all(batchPromises);
            frames.push(...batchFrames);
            
            // Allow browser to breathe between batches
            if (start + batchSize <= frameMax) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
    
        return frames;
    }
    
    async loadSingleFrame(zip, frameNum) {
        const layers = await this.loadLayers(zip, frameNum);
        
        if (layers.length > 0) {
            const merged = this.mergeLayers(layers);
            // Clean up layer ImageBitmaps to free memory
            layers.forEach(layer => {
                if (layer.close) layer.close();
            });
            return merged;
        } else {
            console.warn(`Frame ${frameNum} has no layers at all, creating blank frame`);
            return this.createBlankFrame();
        }
    }
    
    async loadLayers(zip, frameNum) {
        const layers = [];
        let layerNum = 0;
    
        while (true) {
            const fileName = `${frameNum},${layerNum}.png`;
            const file = zip.file(fileName);
    
            if (!file) {
                console.warn(`Missing layer ${layerNum} for frame ${frameNum}, skipping...`);
                layerNum++;
                if (layerNum > 3) break; 
                continue;
            }
    
            const blob = await file.async('blob');
            layers.push(await createImageBitmap(blob));
            layerNum++;
        }
    
        return layers;
    }
    
    mergeLayers(layers) {
        const canvas = document.createElement('canvas');
        canvas.width = this.width;
        canvas.height = this.height;
        const ctx = canvas.getContext('2d');
    
        if (layers.length === 0) {
            console.warn("No layers to merge!");
        }
    
        layers.forEach((layer) => {
            ctx.drawImage(layer, 0, 0);
        });
    
        return canvas;
    }
    
    createBlankFrame() {
        const canvas = document.createElement('canvas');
        canvas.width = this.width;
        canvas.height = this.height;
        return canvas;
    }

    async loadSound(zip) {
        const soundFile = zip.file('sound.ogg');
        if (soundFile) {
            const blob = await soundFile.async('blob');
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            return audio;
        }
        return null;
    }
        createPlayerContainer() {
        // create a relative container to hold canvas, menu button and overlay UI
        this.playerContainer = document.createElement('div');
        this.playerContainer.classList.add('clipnote-player-container');
        this.playerContainer.style.position = 'relative';
        this.playerContainer.style.width = `${this.width}px`;
        this.playerContainer.style.height = `${this.height}px`;
        this.playerContainer.style.overflow = `hidden`;
        this.element.appendChild(this.playerContainer);
    }

  createCanvas() {
        // If container wasn't created yet, create it
        if (!this.playerContainer) this.createPlayerContainer();

        this.canvas = document.createElement('canvas');
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.canvas.style.display = 'block';
        this.canvas.style.position = 'absolute';
        this.canvas.style.left = '0';
        this.canvas.style.top = '0';
        this.canvas.style.zIndex = '1';
        this.ctx = this.canvas.getContext('2d');
        this.playerContainer.appendChild(this.canvas);
        
        // Setup canvas interactions now that canvas exists
        this.setupCanvasInteractions();
    }

    createUI() {
        // controls overlay (hidden by default)
        this.controls = document.createElement('div');
        this.controls.classList.add('clipnote-controls');
        this.controls.style.position = 'absolute';
        this.controls.style.left = '0';
        this.controls.style.bottom = '0';
        this.controls.style.zIndex = '3';
        this.controls.style.display = 'none';
        this.controls.style.backgroundImage = 'url(img/playerbottom2.png)';
        this.controls.style.imageRendering = 'pixelated';
        this.controls.style.maxWidth = `${this.width}px`;
        this.controls.style.maxHeight = '30px';
        

        // inner HTML for controls
        this.controls.innerHTML = `
            <button class="play-pause" title="Play/Pause">
                <img src="img/playericon1.png" alt="Play" />
            </button>
            <input type="range" min="0" max="${this.frameMax}" value="0" class="timeline">
            <button class="mute-unmute" title="Mute">
                <img src="img/volume1.png" alt="Audio Button" />
            </button>
            <input type="range" min="0" max="1" step="0.1" value="1" class="volume">
        `;
        this.playerContainer.appendChild(this.controls);

        // menu button (left-bottom) - visible initially
        this.menuButton = document.createElement('button');
        this.menuButton.classList.add('clipnote-menu-button');
        this.menuButton.style.position = 'absolute';
        this.menuButton.style.left = '6px';
        this.menuButton.style.bottom = '6px';
        this.menuButton.style.zIndex = '4';
        this.menuButton.style.background = 'transparent';
        this.menuButton.style.border = 'none';
        this.menuButton.style.padding = '0';
        const btnImg = document.createElement('img');
        btnImg.src = this.menuImage;
        btnImg.style.width = '28px';
        btnImg.style.height = '28px';
        btnImg.style.imageRendering = 'pixelated';
        this.menuButton.appendChild(btnImg);
        this.playerContainer.appendChild(this.menuButton);

        // references to elements
        this.playPauseButton = this.controls.querySelector('.play-pause');
        this.timeline = this.controls.querySelector('.timeline');
        this.volumebtn = this.controls.querySelector('.mute-unmute');
        this.volume = this.controls.querySelector('.volume');

        // Styles for play and volume buttons
        [this.playPauseButton, this.volumebtn].forEach(btn => {
            btn.style.backgroundColor = 'transparent';
            btn.style.position = 'relative';
            btn.style.top = '3px';
            btn.style.left = '4px';
            btn.style.maxWidth = '25px';
            btn.style.maxHeight = '25px';
            btn.style.minWidth = '25px';
            btn.style.minHeight = '25px';
            btn.style.imageRendering = 'pixelated';
            btn.style.border = 'none';
        });

        // timeline and volume styling
        this.timeline.style.width = Math.max(100, this.width - 110) + 'px';
        this.timeline.style.position = 'relative';
        this.volume.style.width = '65px';
        this.volume.style.position = 'relative';

        // thumb CSS injection (only once)
        if (!document.getElementById('clipnote-slider-styles')) {
            const style = document.createElement('style');
            style.id = 'clipnote-slider-styles';
            style.innerHTML = `
                .timeline::-webkit-slider-thumb, .volume::-webkit-slider-thumb {
                    background: url('img/playerthingy.png') no-repeat center;
                    background-size: contain;
                    width: 16px;
                    height: 16px;
                    border: none;
                    cursor: pointer;
                    appearance: none;
                }
                .timeline::-moz-range-thumb, .volume::-moz-range-thumb {
                    background: url('img/playerthingy.png') no-repeat center;
                    background-size: contain;
                    width: 18px;
                    height: 18px;
                    border: none;
                    cursor: pointer;
                }
            `;
            document.head.appendChild(style);
        }

        // slider background helper - make it a class method with proper thumb alignment
        this.updateSliderBackground = (slider) => {
            const percentage = (slider.value - slider.min) / (slider.max - slider.min) * 100;
            // Adjust for circular thumb visual center - thumb is 16px wide, so we need to account for the visual offset
            const thumbWidth = 16;
            const sliderWidth = slider.offsetWidth;
            const thumbOffset = thumbWidth / 2;
            const adjustedPercentage = percentage * (sliderWidth - thumbWidth) / sliderWidth + (thumbOffset / sliderWidth * 100);
            slider.style.background = `linear-gradient(to right, #ccccff ${adjustedPercentage}%, #7e73e7 ${adjustedPercentage}%)`;
        };
  // Apply styles to timeline and volume
        this.timeline.style.background = 'linear-gradient(to right, #ccccff 0%, #7e73e7 0%)';
        this.volume.style.background = 'linear-gradient(to right, #ccccff 100%, #7e73e7 0%)';
    
        // Update the timeline and volume background on input
        this.timeline.addEventListener('input', () => {
            this.updateSliderBackground(this.timeline);
        });
        this.volume.addEventListener('input', () => {
            this.updateSliderBackground(this.volume);
        });
    
        // Background updates are handled by the animation loop now
    
        // Initialize slider backgrounds on load
        this.updateSliderBackground(this.timeline);
        this.updateSliderBackground(this.volume);

        // show/hide UI logic
        this.hideUiTimer = null;
        
        // Mouse proximity detection for cat menu button
        this.setupMouseProximityDetection();
        
        this.menuButton.addEventListener('click', () => {
            // Fade out cat and show controls with spring animation
            this.menuButton.style.opacity = '0';
            setTimeout(() => {
                this.menuButton.style.display = 'none';
            }, 300);
            this.showControlsWithSpring();
        });

        // interactions reset the hide timer
        const resetHideTimer = () => {
            if (this.hideUiTimer) {
                clearTimeout(this.hideUiTimer);
            }
            this.hideUiTimer = setTimeout(() => {
                this.hideControlsWithSpring();
            }, 5000);
        };

        // when controls shown, start the auto-hide timer and listen to interactions
        this.controls.addEventListener('pointermove', resetHideTimer);
        this.controls.addEventListener('input', resetHideTimer);
        this.playerContainer.addEventListener('pointermove', resetHideTimer);

        // Event Listeners for media controls
        this.playPauseButton.addEventListener('click', () => this.togglePlay());
        this.timeline.addEventListener('input', () => this.updateFrame());
        this.volumebtn.addEventListener('click', () => this.toggleMute());
        this.volume.addEventListener('input', () => this.updateVolume());

        // keep play icon in sync if audio changes
        if (this.sound) {
            this.sound.addEventListener('ended', () => {
                if (!this.loop) {
                    this.isPlaying = false;
                    this.playPauseButton.innerHTML = '<img src="img/playericon1.png" alt="Play" />';
                }
            });
        }
    }
    
    showControls() {
        this.controls.style.display = 'flex';
        this.controls.style.alignItems = 'center';
        this.controls.style.gap = '8px';
        // start auto-hide timer
        if (this.hideUiTimer) clearTimeout(this.hideUiTimer);
        this.hideUiTimer = setTimeout(() => this.hideControlsWithSpring(), 200);
    }
    
    showControlsWithSpring() {
        // Set up spring animation styles
        this.controls.style.transition = 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1), opacity 0.3s ease-out';
        
        // Start from below and invisible
        this.controls.style.transform = 'translateY(15px)';
        this.controls.style.opacity = '0';
        this.controls.style.display = 'flex';
        this.controls.style.alignItems = 'center';
        this.controls.style.gap = '8px';
        
        // Animate to final position with spring effect
        setTimeout(() => {
            this.controls.style.transform = 'translateY(0)';
            this.controls.style.opacity = '1';
        }, 10);
        
        // start auto-hide timer
        if (this.hideUiTimer) clearTimeout(this.hideUiTimer);
        this.hideUiTimer = setTimeout(() => this.hideControlsWithSpring(), 2000);
    }

    
    
    
    setupPlayback() {
        this.isPlaying = false;
        this.currentFrame = 0;
        this.lastFrameTime = 0;
        this.frameInterval = 1000 / this.framerate;
        this.animationId = null;
        this.startTime = 0;
        this.pausedTime = 0;
    }
    
    setupCanvasInteractions() {
        // Canvas click to play/pause
        this.canvas.addEventListener('click', () => this.togglePlay());
        this.canvas.style.cursor = 'pointer';
        
        // Add keyboard event listener to document
        this.keyboardHandler = (event) => {
            // Only respond when the player container is in focus/view
            const rect = this.playerContainer.getBoundingClientRect();
            const isVisible = rect.top >= 0 && rect.left >= 0 && 
                             rect.bottom <= window.innerHeight && 
                             rect.right <= window.innerWidth;
            
            if (!isVisible) return;
            
            // Prevent default behavior to avoid page scrolling on spacebar
            if (event.code === 'Space') {
                event.preventDefault();
                this.togglePlay();
            } else if (event.code === 'KeyM') {
                event.preventDefault();
                this.toggleMute();
            } else if (event.code === 'ArrowLeft') {
                event.preventDefault();
                this.scrubFrame(-1);
            } else if (event.code === 'ArrowRight') {
                event.preventDefault();
                this.scrubFrame(1);
            }
        };
        
        document.addEventListener('keydown', this.keyboardHandler);
    }

   togglePlay() {
        // If clip finished and not looping, restart from beginning
        if (!this.loop && this.frames && this.currentFrame >= this.frames.length) {
            this.currentFrame = 0;
            if (this.sound) this.sound.currentTime = 0;
        }

        this.isPlaying = !this.isPlaying;
        this.playPauseButton.innerHTML = this.isPlaying 
            ? '<img src="img/playericon2.png" alt="Pause" />' 
            : '<img src="img/playericon1.png" alt="Play" />';

        if (this.isPlaying) {
            // If starting playback when at or beyond last frame, reset
            if (this.frames && this.currentFrame >= this.frames.length) {
                this.currentFrame = 0;
            }

            // Set proper start time for timing calculations
            this.startTime = performance.now() - (this.currentFrame * this.frameInterval);
            
            // Draw the current frame immediately
            if (this.frames && this.frames[this.currentFrame]) {
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                this.ctx.drawImage(this.frames[this.currentFrame], 0, 0);
                this.timeline.value = this.currentFrame;
                this.updateSliderBackground(this.timeline);
            }
            
            if (this.sound) {
                this.sound.currentTime = this.currentFrame / this.framerate;
                this.sound.play().catch(e => console.warn('Audio play failed:', e));
            }
            
            this.startPlayback();
        } else {
            this.pausedTime = performance.now();
            if (this.animationId) {
                cancelAnimationFrame(this.animationId);
                this.animationId = null;
            }
            if (this.sound) this.sound.pause();
        }
    }
    toggleMute() {
        if (!this.sound) return;
    
        if (this.sound.muted) {
            this.sound.muted = false;
            this.volume.value = this.lastVolume; // Restore previous volume level
            this.volumebtn.innerHTML = '<img src="img/volume1.png" alt="Unmuted" />';
        } else {
            this.lastVolume = this.volume.value; // Save the current volume level
            this.sound.muted = true;
            this.volume.value = 0; // Move slider to 0 when muted
            this.volumebtn.innerHTML = '<img src="img/volume2.png" alt="Muted" />';
        }
        
        // Update the volume slider background after mute/unmute
        this.updateSliderBackground(this.volume);
    }
    
    startPlayback() {
        const update = (timestamp) => {
            if (!this.isPlaying) {
                this.animationId = null;
                return;
            }
    
            // Initialize startTime on first frame if not set
            if (!this.startTime || this.startTime > timestamp) {
                this.startTime = timestamp - (this.currentFrame * this.frameInterval);
            }
    
            // Calculate precise frame based on elapsed time
            const elapsed = timestamp - this.startTime;
            const targetFrame = Math.floor(elapsed / this.frameInterval);
            
            // Only update if we need to show a new frame
            if (targetFrame !== this.currentFrame && targetFrame < this.frames.length) {
                this.currentFrame = targetFrame;
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                this.ctx.drawImage(this.frames[this.currentFrame], 0, 0);
                this.timeline.value = this.currentFrame;
                this.updateSliderBackground(this.timeline);
                
                // Audio sync correction - only adjust if drift is very significant
                if (this.sound && !this.sound.paused) {
                    const expectedAudioTime = this.currentFrame / this.framerate;
                    const actualAudioTime = this.sound.currentTime;
                    const drift = Math.abs(expectedAudioTime - actualAudioTime);
                    
                    // Only correct major drift (>200ms) to avoid stuttering
                    if (drift > 0.2) {
                        this.sound.currentTime = expectedAudioTime;
                    }
                }
            }
    
            // Handle end of animation
            if (targetFrame >= this.frames.length) {
                if (this.loop) {
                    this.startTime = timestamp; // Reset timing for loop
                    this.currentFrame = 0;
                    if (this.sound) {
                        // Always reset audio for loop, regardless of current state
                        this.sound.currentTime = 0;
                        if (this.isPlaying) {
                            this.sound.play().catch(e => console.warn('Audio play failed:', e));
                        }
                    }
                } else {
                    this.isPlaying = false;
                    this.animationId = null;
                    this.playPauseButton.innerHTML = '<img src="img/playericon1.png" alt="Play" />';
                    this.currentFrame = 0; // Reset to beginning for non-looped animations
                    
                    if (this.sound) {
                        this.sound.pause();
                        this.sound.currentTime = 0;
                    }
                    return;
                }
            }
    
            this.animationId = requestAnimationFrame(update);
        };
    
        this.animationId = requestAnimationFrame(update);
    }
    
    updateFrame() {
        const newFrame = parseInt(this.timeline.value);
        
        // Only update if frame actually changed
        if (newFrame !== this.currentFrame) {
            this.currentFrame = newFrame;
            
            // Update timing for precise playback continuation
            if (this.isPlaying) {
                this.startTime = performance.now() - (this.currentFrame * this.frameInterval);
            }
            
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.drawImage(this.frames[this.currentFrame], 0, 0);
            this.updateSliderBackground(this.timeline);
        
            // Only update audio time when not playing to avoid stuttering
            if (this.sound && !this.isPlaying) {
                this.sound.currentTime = this.currentFrame / this.framerate;
                this.sound.pause();
            }
        }
    }
    
    scrubFrame(direction) {
        if (!this.frames || this.frames.length === 0) return;
        
        // Calculate new frame position
        let newFrame = this.currentFrame + direction;
        
        // Clamp to valid range
        newFrame = Math.max(0, Math.min(newFrame, this.frames.length - 1));
        
        // Only update if frame actually changed
        if (newFrame !== this.currentFrame) {
            this.currentFrame = newFrame;
            
            // Update timeline slider
            this.timeline.value = this.currentFrame;
            this.updateSliderBackground(this.timeline);
            
            // Update timing for precise playback continuation if playing
            if (this.isPlaying) {
                this.startTime = performance.now() - (this.currentFrame * this.frameInterval);
            }
            
            // Draw the new frame
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.drawImage(this.frames[this.currentFrame], 0, 0);
            
            // Update audio time when not playing to avoid stuttering
            if (this.sound && !this.isPlaying) {
                this.sound.currentTime = this.currentFrame / this.framerate;
                this.sound.pause();
            }
        }
    }
    updateVolume() {
        if (this.sound) {
            this.sound.volume = this.volume.value;
            if (this.sound.volume == 0) {
                this.sound.muted = true;
                this.volumebtn.innerHTML = '<img src="img/volume2.png" alt="Muted" />';
            } else {
                this.sound.muted = false;
                this.volumebtn.innerHTML = '<img src="img/volume1.png" alt="Unmuted" />';
            }
        }
        
        // Update the volume slider background in real time
        this.updateSliderBackground(this.volume);
    }
    
    // Cleanup method to free resources
    destroy() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        
        if (this.sound) {
            this.sound.pause();
            this.sound.src = '';
            this.sound.load();
        }
        
        if (this.hideUiTimer) {
            clearTimeout(this.hideUiTimer);
            this.hideUiTimer = null;
        }
        
        // Clean up frames
        if (this.frames) {
            this.frames.forEach(frame => {
                if (frame && frame.getContext) {
                    const ctx = frame.getContext('2d');
                    ctx.clearRect(0, 0, frame.width, frame.height);
                }
            });
        }
        
        this.isPlaying = false;
    }
    
    setupMouseProximityDetection() {
        // Initially hide the menu button
        this.menuButton.style.display = 'none';
        this.menuButton.style.opacity = '0';
        this.menuButton.style.transition = 'opacity 0.3s ease-in-out';
        
        // Track hover state to prevent flickering
        this.isHoveringCat = false;
        
        // Add mouse move listener to document to detect proximity
        this.mouseProximityHandler = (event) => {
            if (this.controls.style.display !== 'none') {
                // Don't show cat if controls are already visible
                return;
            }
            
            const rect = this.playerContainer.getBoundingClientRect();
            const mouseX = event.clientX - rect.left;
            const mouseY = event.clientY - rect.top;
            
            // Define proximity zone - larger area extending right and up from cat
            const proximityWidth = 220; // horizontal detection area (extends more to the right)
            const proximityHeight = 100; // vertical detection area (extends more upward)
            
            // Get the menu button's position (it's positioned at left: 6px, bottom: 6px)
            const catPosition = {
                x: 6, // left edge of cat icon
                y: rect.height - 6 - 28 // top edge of cat icon (bottom - height)
            };
            
            // Check if mouse is within the expanded rectangular area
            const isInProximity = (
                mouseX >= catPosition.x - 20 && // extend 20px to the left
                mouseX <= catPosition.x + proximityWidth && // extend right
                mouseY >= catPosition.y - proximityHeight && // extend up
                mouseY <= catPosition.y + 48 // extend 20px below cat (28px height + 20px)
            );
            
            if (isInProximity && !this.isHoveringCat) {
                // Mouse entered proximity area - show cat with fade in
                this.isHoveringCat = true;
                this.menuButton.style.display = 'block';
                this.menuButton.style.opacity = '0'; // Ensure it starts at 0
                // Small delay to ensure display and initial opacity are set
                setTimeout(() => {
                    this.menuButton.style.opacity = '1';
                }, 10); // Small delay to trigger the transition
            } else if (!isInProximity && this.isHoveringCat) {
                // Mouse left proximity area - hide cat with fade out
                this.isHoveringCat = false;
                this.menuButton.style.opacity = '0';
                // Hide display after animation completes
                setTimeout(() => {
                    if (!this.isHoveringCat) {
                        this.menuButton.style.display = 'none';
                    }
                }, 300); // Wait for fade animation to complete
            }
        };
        
        document.addEventListener('mousemove', this.mouseProximityHandler);
    }
    
    // Update hideControls to reset cat visibility
    hideControls() {
        this.controls.style.display = 'none';
        // Don't automatically show menu button anymore - let proximity detection handle it
        if (this.hideUiTimer) {
            clearTimeout(this.hideUiTimer);
            this.hideUiTimer = null;
        }
    }
    
    hideControlsWithSpring() {
        // Set up spring animation for hiding - easing that goes straight down
        this.controls.style.transition = 'transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.2s ease-in';
        
        // Animate further down (out of view) and invisible
        this.controls.style.transform = 'translateY(70px)';
        this.controls.style.opacity = '0';
        
        // Hide display after animation
        setTimeout(() => {
            this.controls.style.display = 'none';
            // Reset transform for next show (back to starting position)
            this.controls.style.transform = 'translateY(15px)';
        }, 100);
        
        if (this.hideUiTimer) {
            clearTimeout(this.hideUiTimer);
            this.hideUiTimer = null;
        }
    }
    
    // Cleanup method to free resources
    destroy() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        
        if (this.sound) {
            this.sound.pause();
            this.sound.src = '';
            this.sound.load();
        }
        
        if (this.hideUiTimer) {
            clearTimeout(this.hideUiTimer);
            this.hideUiTimer = null;
        }
        
        // Remove mouse proximity listener
        if (this.mouseProximityHandler) {
            document.removeEventListener('mousemove', this.mouseProximityHandler);
        }
        
        // Remove keyboard listener
        if (this.keyboardHandler) {
            document.removeEventListener('keydown', this.keyboardHandler);
        }
        
        // Clean up frames
        if (this.frames) {
            this.frames.forEach(frame => {
                if (frame && frame.getContext) {
                    const ctx = frame.getContext('2d');
                    ctx.clearRect(0, 0, frame.width, frame.height);
                }
            });
        }
        
        this.isPlaying = false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('clipnote-image, clipnote-player').forEach(el => new ClipnotePlayer(el));
});