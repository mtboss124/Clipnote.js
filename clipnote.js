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
        const zip = await JSZip.loadAsync(blob);

        if (this.isImage) {
            this.loadThumbnail(zip);
        } else {
            this.loadAnimation(zip);
        }
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
        
        for (let i = 0; i <= frameMax; i++) {
            const layers = await this.loadLayers(zip, i);
    
            if (layers.length > 0) {
                frames.push(this.mergeLayers(layers));
            } else {
                console.warn(`Frame ${i} has no layers at all, creating blank frame`);
                frames.push(this.createBlankFrame());
            }
        }
    
        return frames;
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
    
            console.log(`Loading ${fileName}`);
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
    
        layers.forEach((layer, index) => {
            console.log(`Drawing layer ${index}`);
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

        // slider background helper
        function updateSliderBackground(slider) {
            const percentage = (slider.value - slider.min) / (slider.max - slider.min) * 100;
            slider.style.background = `linear-gradient(to right, #ccccff ${percentage}%, #7e73e7 ${percentage}%)`;
        }
  // Apply styles to timeline and volume
        this.timeline.style.background = 'linear-gradient(to right, #ccccff 0%, #444 0%)';
        this.volume.style.background = 'linear-gradient(to right, #ccccff 100%, #444 0%)';
    
        // Update the timeline and volume background on input
        this.timeline.addEventListener('input', function() {
            updateSliderBackground(this);
        });
        this.volume.addEventListener('input', function() {
            updateSliderBackground(this);
        });
    
        // Ensure real-time updates during playback
        setInterval(() => {
            updateSliderBackground(this.timeline);
        }, 100);
    
        // Initialize slider backgrounds on load
        updateSliderBackground(this.timeline);
        updateSliderBackground(this.volume);

        // show/hide UI logic
        this.hideUiTimer = null;
        this.menuButton.addEventListener('click', () => {
            this.menuButton.style.display = 'none';
            this.showControls();
        });

        // interactions reset the hide timer
        const resetHideTimer = () => {
            if (this.hideUiTimer) {
                clearTimeout(this.hideUiTimer);
            }
            this.hideUiTimer = setTimeout(() => {
                this.hideControls();
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
        this.hideUiTimer = setTimeout(() => this.hideControls(), 2000);
    }

    hideControls() {
        this.controls.style.display = 'none';
        this.menuButton.style.display = 'block';
        if (this.hideUiTimer) {
            clearTimeout(this.hideUiTimer);
            this.hideUiTimer = null;
        }
    }
    
    
    
    setupPlayback() {
        this.isPlaying = false;
        this.currentFrame = 0;
    }

   togglePlay() {
        // If clip finished and not looping, restart from beginning
        if (!this.loop && !this.isPlaying && this.frames && this.currentFrame >= this.frames.length) {
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

            this.startPlayback();
            if (this.sound) {
                this.sound.currentTime = this.currentFrame / this.framerate;
                this.sound.play();
            }
        } else {
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
    }
    
    startPlayback() {
        const update = () => {
            if (!this.isPlaying) return;
    
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.drawImage(this.frames[this.currentFrame], 0, 0);
            this.timeline.value = this.currentFrame;
    
            this.currentFrame++;
    
            if (this.currentFrame >= this.frames.length) {
                if (this.loop) {
                    this.currentFrame = 0;
                    if (this.sound) this.sound.currentTime = 0; // Reset sound to start
                } else {
                    this.isPlaying = false;
                    this.playPauseButton.innerHTML = '<img src="img/playericon1.png" alt="Play" />'; // Reset to play icon
    
                    if (this.sound) {
                        this.sound.pause();
                        this.sound.currentTime = 0; // Ensure sound stops
                    }
                    return;
                }
            }
    
            setTimeout(update, 1000 / this.framerate);
        };
    
        update();
    }
    
    updateFrame() {
        this.currentFrame = parseInt(this.timeline.value);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(this.frames[this.currentFrame], 0, 0);
    
        if (this.sound) {
            this.sound.currentTime = this.currentFrame / this.framerate;
            if (!this.isPlaying) this.sound.pause(); // Ensure it doesn't play when paused
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
    }
    
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('clipnote-image, clipnote-player').forEach(el => new ClipnotePlayer(el));
});
