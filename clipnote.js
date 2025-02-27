class ClipnotePlayer {
    constructor(element) {
        this.element = element;
        this.url = element.getAttribute('url');
        this.width = element.getAttribute('width') || '320';
        this.height = element.getAttribute('height') || '240';
        this.isImage = element.tagName.toLowerCase() === 'clipnote-image';
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
        this.createUI();
        this.createCanvas();
        this.setupPlayback();

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
            frames.push(layers.length ? this.mergeLayers(layers) : this.createBlankFrame());
        }
        return frames;
    }

    async loadLayers(zip, frameNum) {
        const layers = [];
        let layerNum = 0;
        while (true) {
            const fileName = `${frameNum},${layerNum}.png`;
            const file = zip.file(fileName);
            if (!file) break;
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
        layers.forEach(layer => ctx.drawImage(layer, 0, 0));
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

    createCanvas() {
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.ctx = this.canvas.getContext('2d');
        this.playerContainer.appendChild(this.canvas);
    }

    createUI() {
        this.playerContainer = document.createElement('div');
        this.playerContainer.classList.add('clipnote-player-container');
        this.element.appendChild(this.playerContainer);

        this.controls = document.createElement('div');
        this.controls.classList.add('clipnote-controls');
        this.controls.innerHTML = `
            <button class="play-pause">▶</button>
            <input type="range" min="0" max="${this.frameMax}" value="0" class="timeline">
            <input type="range" min="0" max="1" step="0.1" value="1" class="volume">
        `;
        this.playerContainer.appendChild(this.controls);

        this.playPauseButton = this.controls.querySelector('.play-pause');
        this.timeline = this.controls.querySelector('.timeline');
        this.volume = this.controls.querySelector('.volume');

        this.playPauseButton.addEventListener('click', () => this.togglePlay());
        this.timeline.addEventListener('input', () => this.updateFrame());
        this.volume.addEventListener('input', () => { if (this.sound) this.sound.volume = this.volume.value; });
    }

    setupPlayback() {
        this.isPlaying = false;
        this.currentFrame = 0;
    }

    togglePlay() {
        this.isPlaying = !this.isPlaying;
        this.playPauseButton.textContent = this.isPlaying ? '⏸' : '▶';
        if (this.isPlaying) {
            this.startPlayback();
            if (this.sound) this.sound.play();
        } else {
            if (this.sound) this.sound.pause();
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
                if (this.loop) this.currentFrame = 0;
                else { this.isPlaying = false; this.playPauseButton.textContent = '▶'; return; }
            }
            setTimeout(update, 1000 / this.framerate);
        };
        update();
    }

    updateFrame() {
        this.currentFrame = parseInt(this.timeline.value);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(this.frames[this.currentFrame], 0, 0);
        if (this.sound) this.sound.currentTime = this.currentFrame / this.framerate;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('clipnote-image, clipnote-player').forEach(el => new ClipnotePlayer(el));
});
