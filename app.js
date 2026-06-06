/* ============================================
   KINGAPLAY v4.0
   - Sin filtros de formato visibles (se usan internamente)
   - Controles completos: Play, Pause, Stop, Anterior, Siguiente
   - Controles de audio: Volumen, Silenciar, Ecualizador
   - Gestión de Listas de reproducción
   - Reproducción online: YouTube embed + radios web
   ============================================ */
'use strict';

/* ── ÍCONO PERSONALIZADO ─────────────────────
   Cambia '' por la ruta de tu imagen PNG/JPG
   Ejemplo: './mi-logo.png'
   ─────────────────────────────────────────── */
const APP_ICON = '';

/* ── ESTADO ──────────────────────────────── */
let library           = [];
let videoLibrary      = [];
let playlists         = [];        // [{id, name, tracks:[{type,idx}]}]
let currentTrackIndex = -1;
let currentVideoIndex = -1;
let isMuted           = false;
let isVideoMuted      = false;
let lastVolume        = 80;
let isShuffle         = false;
let repeatMode        = 'none';
let favorites         = new Set();
let currentFilter     = 'all';
let currentVideoFilter= 'all';
let contextTrackIndex = -1;
let contextType       = 'audio';
let videoControlsTimer= null;
let audioCtx          = null;
let gainNode          = null;
let eqFilters         = [];
let onlinePlaying     = false;
let addToPlaylistTarget = null;  // {index, type}

const EQ_BANDS = [
  {freq:60,label:'60'},{freq:170,label:'170'},{freq:310,label:'310'},
  {freq:600,label:'600'},{freq:1000,label:'1K'},{freq:3000,label:'3K'},
  {freq:6000,label:'6K'},{freq:12000,label:'12K'},{freq:14000,label:'14K'},{freq:16000,label:'16K'},
];
const EQ_PRESETS = {
  flat:     [0,0,0,0,0,0,0,0,0,0],
  bass:     [8,6,4,2,0,-1,-2,-2,-2,-2],
  rock:     [5,4,3,1,-1,0,1,2,3,4],
  pop:      [-1,-1,0,2,4,4,2,0,-1,-1],
  jazz:     [3,2,1,2,-2,-2,0,1,2,3],
  classical:[4,3,2,0,-2,-2,0,2,3,4],
};

const AUDIO_EXTS = ['mp3','flac','aac','wav','ogg','m4a','wma','opus'];
const VIDEO_EXTS = ['mp4','mkv','webm','mov','avi','m4v','3gp','ogv','ts'];

// Radios predefinidas
const PRESET_RADIOS = [
  { name:'Rock FM',       url:'https://playerservices.streamtheworld.com/api/livestream-redirect/ROCK_FM.mp3',       genre:'Rock'    },
  { name:'Jazz24',        url:'https://live.wostreaming.net/direct/ppm-jazz24aac-ibc1',                             genre:'Jazz'    },
  { name:'Salsa Beta',    url:'https://stream.zeno.fm/yn65m7h52zzuv',                                               genre:'Salsa'   },
  { name:'RFI Español',   url:'https://live02.rfi.fr/rfi-esp-128.mp3',                                              genre:'Noticias'},
  { name:'Classic FM',    url:'https://media-ice.musicradio.com/ClassicFMMP3',                                      genre:'Clásica' },
  { name:'Electronic FM', url:'https://stream.zeno.fm/f3wvbbqmdg8uv',                                              genre:'Electro' },
];

/* ── INIT ─────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  applyAppIcon();
  loadState();
  buildEQ();
  buildRadioGrid();
  startSplash();
});

function startSplash() {
  setTimeout(() => {
    document.getElementById('splash').classList.add('out');
    setTimeout(() => {
      document.getElementById('splash').style.display = 'none';
      document.getElementById('app').classList.remove('hidden');
    }, 600);
  }, 1800);
}

function applyAppIcon() {
  if (!APP_ICON) return;
  const si = document.getElementById('splashIcon');
  if (si) si.innerHTML = `<img src="${APP_ICON}" alt="KingaPlay" style="width:80px;height:80px;object-fit:cover;border-radius:20px;">`;
  let link = document.querySelector("link[rel~='icon']");
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.href = APP_ICON;
}

/* ── AUDIO CONTEXT ───────────────────────── */
function initAudioContext() {
  if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1.0;
    eqFilters = EQ_BANDS.map((band, i) => {
      const f = audioCtx.createBiquadFilter();
      f.type  = i === 0 ? 'lowshelf' : i === EQ_BANDS.length-1 ? 'highshelf' : 'peaking';
      f.frequency.value = band.freq; f.Q.value = 1.4; f.gain.value = 0;
      return f;
    });
    let prev = gainNode;
    eqFilters.forEach(f => { prev.connect(f); prev = f; });
    prev.connect(audioCtx.destination);
  } catch(e) { audioCtx = null; }
}

/* ── AUDIO ELEMENT ───────────────────────── */
const audioEl = document.getElementById('audioEl');
audioEl.addEventListener('timeupdate',     updateProgress);
audioEl.addEventListener('ended',          handleEnded);
audioEl.addEventListener('loadedmetadata', () => updateTotalTime(audioEl.duration));
audioEl.addEventListener('play',           () => setPlayingUI(true));
audioEl.addEventListener('pause',          () => setPlayingUI(false));
audioEl.addEventListener('error',          () => showToast('Error al reproducir el archivo'));

/* ── ESCANEO ─────────────────────────────── */
function scanFiles(type) {
  const isVideo   = type === 'video';
  const acceptStr = isVideo
    ? 'video/*,.mp4,.mkv,.webm,.mov,.avi,.m4v,.3gp,.ogv'
    : 'audio/*,.mp3,.flac,.aac,.wav,.ogg,.m4a,.wma,.opus';
  const input = document.createElement('input');
  input.type = 'file'; input.accept = acceptStr; input.multiple = true;
  input.onchange = e => processFiles(Array.from(e.target.files), type);
  input.click();
}

function processFiles(files, type) {
  if (!files.length) return;
  const isVideo   = type === 'video';
  const targetLib = isVideo ? videoLibrary : library;

  document.getElementById('scanTitle').textContent  = isVideo ? 'Escaneando Videos' : 'Escaneando Audio';
  document.getElementById('scanStatus').textContent = 'Preparando...';
  document.getElementById('scanFill').style.width   = '0%';
  document.getElementById('scanCount').textContent  = '0 archivos';
  document.getElementById('scan-modal').classList.remove('hidden');

  let processed = 0, added = 0;
  const total = files.length;

  files.forEach((file, idx) => {
    setTimeout(() => {
      const ext       = file.name.split('.').pop().toLowerCase();
      const validExts = isVideo ? VIDEO_EXTS : AUDIO_EXTS;
      const validMime = isVideo ? file.type.startsWith('video/') : file.type.startsWith('audio/');

      // Solo procesar archivos de audio válidos (no reproducir otra cosa)
      if (validExts.includes(ext) || validMime) {
        if (!targetLib.find(t => t.name === file.name && t.size === file.size)) {
          targetLib.push(isVideo ? buildVideo(file) : buildTrack(file));
          added++;
        }
      }
      processed++;
      document.getElementById('scanFill').style.width   = Math.round(processed/total*100) + '%';
      document.getElementById('scanCount').textContent  = `${added} nuevos / ${processed} procesados`;
      document.getElementById('scanStatus').textContent = file.name;

      if (processed === total) {
        setTimeout(() => {
          document.getElementById('scan-modal').classList.add('hidden');
          isVideo ? renderVideos() : renderLibrary();
          updateStats(); saveState();
          showToast(`✓ ${added} ${isVideo ? 'videos' : 'canciones'} añadidos`);
        }, 400);
      }
    }, idx * 10);
  });
}

function buildTrack(file) {
  const name   = file.name.replace(/\.[^.]+$/, '');
  const ext    = file.name.split('.').pop().toLowerCase();
  const parts  = name.split(' - ');
  const artist = parts.length > 1 ? parts[0].trim() : 'Artista Desconocido';
  const title  = parts.length > 1 ? parts.slice(1).join(' - ').trim() : name;
  return {
    id: Date.now() + Math.random(), name: file.name,
    title, artist, folder: 'Música', format: ext.toUpperCase(),
    size: file.size, sizeLabel: formatBytes(file.size),
    url: URL.createObjectURL(file), type: 'audio',
  };
}

function buildVideo(file) {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext  = file.name.split('.').pop().toLowerCase();
  return {
    id: Date.now() + Math.random(), name: file.name,
    title: name, folder: 'Videos', format: ext.toUpperCase(),
    size: file.size, sizeLabel: formatBytes(file.size),
    url: URL.createObjectURL(file), type: 'video',
  };
}

/* ── RENDER AUDIO ────────────────────────── */
function renderLibrary(tracks) {
  const list = tracks !== undefined ? tracks : library;
  const el   = document.getElementById('song-list');

  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🎵</div>
      <p>Escanea tus archivos de audio<br>para comenzar a escuchar</p>
      <button class="btn-primary" onclick="scanFiles('audio')">Escanear Audio</button>
    </div>`;
    el.onclick = null; el.oncontextmenu = null; return;
  }

  el.innerHTML = list.map((t, i) => {
    const libIdx = library.indexOf(t);
    const isFav  = favorites.has('audio_' + libIdx);
    const isAct  = currentTrackIndex === libIdx;
    return `<div class="song-item${isAct ? ' playing' : ''}" data-idx="${libIdx}">
      <div class="song-num">${isAct
        ? '<div class="song-playing-bars"><div class="sp-bar"></div><div class="sp-bar"></div><div class="sp-bar"></div></div>'
        : (i + 1)}</div>
      <div class="song-meta">
        <div class="song-name">${esc(t.title)}</div>
        <div class="song-artist">${esc(t.artist)}</div>
      </div>
      <button class="song-fav-btn${isFav ? ' active' : ''}"
        data-fav-idx="${libIdx}" data-fav-type="audio">
        <svg viewBox="0 0 24 24">
          <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"
            fill="${isFav ? 'var(--accent)' : 'none'}" stroke="currentColor" stroke-width="2"/>
        </svg>
      </button>
    </div>`;
  }).join('');

  el.onclick = e => {
    const fav = e.target.closest('[data-fav-idx]');
    if (fav) { e.stopPropagation(); toggleFavorite(+fav.dataset.favIdx, fav.dataset.favType); return; }
    const item = e.target.closest('.song-item[data-idx]');
    if (item) playTrack(+item.dataset.idx);
  };
  el.oncontextmenu = e => {
    const item = e.target.closest('.song-item[data-idx]');
    if (item) showContext(e, +item.dataset.idx, 'audio');
  };
}

function searchLibrary(q) {
  if (!q.trim()) { renderLibrary(); return; }
  const lq = q.toLowerCase();
  renderLibrary(library.filter(t =>
    t.title.toLowerCase().includes(lq) ||
    t.artist.toLowerCase().includes(lq)
  ));
}

/* ── RENDER VIDEO ────────────────────────── */
function renderVideos(vids) {
  const list = vids !== undefined ? vids : videoLibrary;
  const el   = document.getElementById('video-list');

  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🎬</div>
      <p>Escanea tus archivos de video<br>para comenzar a reproducir</p>
      <button class="btn-primary" onclick="scanFiles('video')">Escanear Videos</button>
    </div>`;
    el.onclick = null; el.oncontextmenu = null; return;
  }

  el.innerHTML = list.map(v => {
    const vidIdx = videoLibrary.indexOf(v);
    const isAct  = currentVideoIndex === vidIdx;
    return `<div class="video-card${isAct ? ' playing' : ''}" data-vid-idx="${vidIdx}">
      <div class="video-card-body">
        <div class="video-card-icon">▶</div>
        <div class="video-card-info">
          <div class="video-card-title">${esc(v.title)}</div>
          <div class="video-card-sub">
            <span class="video-card-size">${v.sizeLabel}</span>
            ${isAct ? '<span class="video-playing-badge">EN REPRODUCCIÓN</span>' : ''}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  el.onclick = e => {
    const card = e.target.closest('.video-card[data-vid-idx]');
    if (card) playVideo(+card.dataset.vidIdx);
  };
  el.oncontextmenu = e => {
    const card = e.target.closest('.video-card[data-vid-idx]');
    if (card) showContext(e, +card.dataset.vidIdx, 'video');
  };
}

function searchVideos(q) {
  if (!q.trim()) { renderVideos(); return; }
  const lq = q.toLowerCase();
  renderVideos(videoLibrary.filter(v => v.title.toLowerCase().includes(lq)));
}

/* ── RENDER FAVORITOS ────────────────────── */
function renderFavorites() {
  const el    = document.getElementById('favorites-list');
  const items = [];
  favorites.forEach(key => {
    const [type, idx] = key.split('_');
    const item = type === 'audio' ? library[+idx] : videoLibrary[+idx];
    if (item) items.push({ item, type, idx: +idx });
  });

  if (!items.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">❤️</div><p>Agrega archivos a favoritos<br>tocando el corazón</p></div>`;
    el.onclick = null; return;
  }
  el.innerHTML = items.map(({ item, type, idx }, i) => {
    const isAct = type === 'audio' ? currentTrackIndex === idx : currentVideoIndex === idx;
    return `<div class="song-item${isAct ? ' playing' : ''}" data-fav-play-idx="${idx}" data-fav-play-type="${type}">
      <div class="song-num">${isAct
        ? '<div class="song-playing-bars"><div class="sp-bar"></div><div class="sp-bar"></div><div class="sp-bar"></div></div>'
        : (i+1)}</div>
      <div class="song-meta">
        <div class="song-name">${esc(item.title)}</div>
        <div class="song-artist">${type === 'audio' ? esc(item.artist||'—') : `Video · ${item.format}`}</div>
      </div>
      <button class="song-fav-btn active" data-fav-idx="${idx}" data-fav-type="${type}">
        <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" fill="var(--accent)" stroke="var(--accent)" stroke-width="2"/></svg>
      </button>
    </div>`;
  }).join('');

  el.onclick = e => {
    const fav = e.target.closest('[data-fav-idx]');
    if (fav) { e.stopPropagation(); toggleFavorite(+fav.dataset.favIdx, fav.dataset.favType); return; }
    const item = e.target.closest('[data-fav-play-idx]');
    if (item) {
      const t = item.dataset.favPlayType, i = +item.dataset.favPlayIdx;
      t === 'audio' ? playTrack(i) : playVideo(i);
    }
  };
}

/* ── LISTAS DE REPRODUCCIÓN ──────────────── */
function renderPlaylists() {
  const el = document.getElementById('playlist-list');
  if (!playlists.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><p>No tienes listas de reproducción<br>Crea una para organizar tu música</p><button class="btn-primary" onclick="showCreatePlaylist()">Crear Lista</button></div>`;
    return;
  }
  el.innerHTML = playlists.map((pl, i) =>
    `<div class="playlist-item" data-pl-idx="${i}">
      <div class="playlist-item-icon">
        <svg viewBox="0 0 24 24"><line x1="8" y1="6" x2="21" y2="6" stroke="currentColor" stroke-width="2"/><line x1="8" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2"/><line x1="8" y1="18" x2="21" y2="18" stroke="currentColor" stroke-width="2"/><circle cx="3" cy="6" r="1" fill="currentColor"/><circle cx="3" cy="12" r="1" fill="currentColor"/><circle cx="3" cy="18" r="1" fill="currentColor"/></svg>
      </div>
      <div class="playlist-item-info">
        <div class="playlist-item-name">${esc(pl.name)}</div>
        <div class="playlist-item-count">${pl.tracks.length} pistas</div>
      </div>
      <div class="playlist-item-actions">
        <button class="pl-action-btn play" onclick="event.stopPropagation();playPlaylist(${i})" title="Reproducir">
          <svg viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>
        </button>
        <button class="pl-action-btn delete" onclick="event.stopPropagation();deletePlaylist(${i})" title="Eliminar">
          <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="2" fill="none"/><path d="M19 6l-1 14H6L5 6" stroke="currentColor" stroke-width="2" fill="none"/></svg>
        </button>
      </div>
    </div>`
  ).join('');

  el.onclick = e => {
    const item = e.target.closest('.playlist-item[data-pl-idx]');
    if (item && !e.target.closest('.pl-action-btn')) openPlaylistDetail(+item.dataset.plIdx);
  };
}

function showCreatePlaylist() {
  closeAddToPlaylist();
  document.getElementById('playlistNameInput').value = '';
  document.getElementById('create-playlist-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('playlistNameInput').focus(), 100);
}
function closeCreatePlaylist() {
  document.getElementById('create-playlist-modal').classList.add('hidden');
}
function createPlaylist() {
  const name = document.getElementById('playlistNameInput').value.trim();
  if (!name) { showToast('Escribe un nombre para la lista'); return; }
  playlists.push({ id: Date.now(), name, tracks: [] });
  closeCreatePlaylist();
  renderPlaylists(); updateStats(); saveState();
  showToast(`✓ Lista "${name}" creada`);
}
function deletePlaylist(idx) {
  const name = playlists[idx]?.name;
  if (!confirm(`¿Eliminar la lista "${name}"?`)) return;
  playlists.splice(idx, 1);
  renderPlaylists(); updateStats(); saveState();
  showToast('Lista eliminada');
}
function openPlaylistDetail(idx) {
  const pl = playlists[idx];
  if (!pl) return;
  // Reproducir primera pista de la lista
  if (!pl.tracks.length) { showToast('La lista está vacía'); return; }
  playPlaylist(idx);
}
function playPlaylist(idx) {
  const pl = playlists[idx];
  if (!pl || !pl.tracks.length) { showToast('La lista está vacía'); return; }
  const first = pl.tracks[0];
  if (first.type === 'audio') playTrack(first.idx);
  else playVideo(first.idx);
  showToast(`▶ Lista: ${pl.name}`);
}

function showAddToPlaylist(index, type) {
  addToPlaylistTarget = { index, type };
  const picker = document.getElementById('playlist-picker');
  if (!playlists.length) {
    picker.innerHTML = `<p class="picker-empty">No tienes listas. Crea una primero.</p>`;
  } else {
    picker.innerHTML = playlists.map((pl, i) =>
      `<div class="picker-item" onclick="addTrackToPlaylist(${i})">
        <span>${esc(pl.name)}</span>
        <span class="picker-count">${pl.tracks.length} pistas</span>
      </div>`
    ).join('');
  }
  document.getElementById('add-playlist-modal').classList.remove('hidden');
}
function closeAddToPlaylist() {
  document.getElementById('add-playlist-modal').classList.add('hidden');
  addToPlaylistTarget = null;
}
function addTrackToPlaylist(plIdx) {
  if (!addToPlaylistTarget) return;
  const { index, type } = addToPlaylistTarget;
  const pl = playlists[plIdx];
  const exists = pl.tracks.find(t => t.idx === index && t.type === type);
  if (exists) { showToast('Ya está en esta lista'); closeAddToPlaylist(); return; }
  pl.tracks.push({ idx: index, type });
  saveState(); renderPlaylists(); updateStats();
  showToast(`✓ Agregado a "${pl.name}"`);
  closeAddToPlaylist();
}
function showAddToPlaylistContext() {
  hideContext();
  showAddToPlaylist(contextTrackIndex, contextType);
}

/* ── REPRODUCCIÓN AUDIO ──────────────────── */
function playTrack(index) {
  if (index < 0 || index >= library.length) return;
  initAudioContext();
  currentTrackIndex = index;
  const track = library[index];

  audioEl.pause();
  audioEl.removeAttribute('src');
  audioEl.load();

  setTimeout(() => {
    audioEl.src = track.url;
    audioEl.load();
    const p = audioEl.play();
    if (p !== undefined) p.catch(() => { setPlayingUI(false); showToast('Toca ▶ para reproducir'); });
  }, 80);

  updatePlayerUI(track);
  updateMiniPlayer(track);
  document.getElementById('mini-player').classList.remove('hidden');
  refreshPlayingClass('audio', index);
  saveState();
}

function togglePlay() {
  if (!library.length) { scanFiles('audio'); return; }
  if (currentTrackIndex < 0) { playTrack(0); return; }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  if (audioEl.paused) audioEl.play().catch(() => showToast('Error al reproducir'));
  else audioEl.pause();
}

function stopTrack() {
  audioEl.pause();
  audioEl.currentTime = 0;
  setPlayingUI(false);
  document.getElementById('progressFill').style.width  = '0%';
  document.getElementById('progressThumb').style.left  = '0%';
  document.getElementById('miniProgressBar').style.width = '0%';
  document.getElementById('currentTime').textContent   = '0:00';
}

function nextTrack() {
  if (!library.length) return;
  if (repeatMode === 'one') { audioEl.currentTime = 0; audioEl.play(); return; }
  const next = isShuffle
    ? Math.floor(Math.random() * library.length)
    : (currentTrackIndex + 1) % library.length;
  playTrack(next);
}

function prevTrack() {
  if (!library.length) return;
  if (audioEl.currentTime > 3) { audioEl.currentTime = 0; return; }
  const prev = isShuffle
    ? Math.floor(Math.random() * library.length)
    : (currentTrackIndex - 1 + library.length) % library.length;
  playTrack(prev);
}

function handleEnded() {
  if (repeatMode === 'one') { audioEl.currentTime = 0; audioEl.play(); }
  else if (repeatMode === 'all' || library.length > 1) nextTrack();
  else setPlayingUI(false);
}

function seekTrack(e) {
  if (!audioEl.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  audioEl.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * audioEl.duration;
}

function toggleShuffle() {
  isShuffle = !isShuffle;
  document.getElementById('shuffleBtn').classList.toggle('active', isShuffle);
  showToast(isShuffle ? '🔀 Aleatorio activado' : '🔀 Desactivado');
}

function toggleRepeat() {
  const modes = ['none','all','one'];
  repeatMode  = modes[(modes.indexOf(repeatMode) + 1) % 3];
  document.getElementById('repeatBtn').classList.toggle('active', repeatMode !== 'none');
  showToast({ none:'↩ Sin repetición', all:'🔁 Repetir todo', one:'🔂 Repetir uno' }[repeatMode]);
}

/* ── CONTROLES DE AUDIO ──────────────────── */
function setVolume(val) {
  const v = parseInt(val);
  audioEl.volume = v / 100;
  lastVolume = v;
  if (isMuted && v > 0) { isMuted = false; updateMuteIcon(); }
  document.getElementById('volValue').textContent = v + '%';
  updateVolumeSliderBg('volumeSlider', v);
}

function toggleMute() {
  isMuted = !isMuted;
  audioEl.muted = isMuted;
  if (isMuted) {
    document.getElementById('volumeSlider').value = 0;
    document.getElementById('volValue').textContent = '0%';
    updateVolumeSliderBg('volumeSlider', 0);
  } else {
    document.getElementById('volumeSlider').value = lastVolume;
    document.getElementById('volValue').textContent = lastVolume + '%';
    updateVolumeSliderBg('volumeSlider', lastVolume);
  }
  updateMuteIcon();
  showToast(isMuted ? '🔇 Silenciado' : '🔊 Sonido activado');
}

function updateMuteIcon() {
  const icon = document.getElementById('muteIcon');
  if (!icon) return;
  if (isMuted) {
    icon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" stroke="currentColor" stroke-width="2" fill="none"/>
      <line x1="23" y1="9" x2="17" y2="15" stroke="currentColor" stroke-width="2"/>
      <line x1="17" y1="9" x2="23" y2="15" stroke="currentColor" stroke-width="2"/>`;
  } else {
    icon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" stroke="currentColor" stroke-width="2" fill="none"/>
      <path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" stroke="currentColor" stroke-width="2" fill="none"/>`;
  }
}

/* ── ECUALIZADOR ─────────────────────────── */
function buildEQ() {
  document.getElementById('eqBands').innerHTML = EQ_BANDS.map((b, i) =>
    `<div class="eq-band">
      <div class="eq-slider-wrap">
        <input type="range" class="eq-slider" min="-12" max="12" value="0"
          data-band="${i}" oninput="setEQBand(${i},this.value)"
          style="-webkit-appearance:slider-vertical;">
      </div>
      <span class="eq-freq">${b.label}</span>
    </div>`
  ).join('');
}
function setEQBand(i, val) { if (eqFilters[i]) eqFilters[i].gain.value = parseFloat(val); }
function setPreset(name, btn) {
  document.querySelectorAll('.eq-preset').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  EQ_PRESETS[name].forEach((v, i) => {
    if (eqFilters[i]) eqFilters[i].gain.value = v;
    const s = document.querySelector(`.eq-slider[data-band="${i}"]`);
    if (s) s.value = v;
  });
  showToast(`EQ: ${btn.textContent}`);
}

/* ── REPRODUCCIÓN VIDEO ──────────────────── */
const videoEl = document.getElementById('videoEl');

function playVideo(index) {
  if (index < 0 || index >= videoLibrary.length) return;
  currentVideoIndex = index;
  const v = videoLibrary[index];
  videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load();
  setTimeout(() => {
    videoEl.src = v.url; videoEl.load();
    openVideoPlayer();
    document.getElementById('videoTitleLabel').textContent = v.title;
    const isFav = favorites.has('video_' + index);
    document.getElementById('videoFavBtn')?.classList.toggle('active', isFav);
    videoEl.play().catch(() => showToast('Toca ▶ para reproducir'));
  }, 80);
  refreshPlayingClass('video', index); saveState();
}

function toggleVideoPlay() {
  if (videoEl.paused) videoEl.play().catch(() => {});
  else videoEl.pause();
  showVideoTapIcon(!videoEl.paused);
}

function stopVideo() {
  videoEl.pause(); videoEl.currentTime = 0;
  updateVideoPlayIcon(false);
  document.getElementById('videoProgressFill').style.width = '0%';
  document.getElementById('videoCurrentTime').textContent  = '0:00';
  showVideoControls();
}

function updateVideoPlayIcon(playing) {
  const pause = `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`;
  const play  = `<polygon points="5,3 19,12 5,21" fill="white"/>`;
  document.getElementById('videoPlayIcon').innerHTML = playing ? pause : play;
}

function videoNext() { if (videoLibrary.length) playVideo((currentVideoIndex + 1) % videoLibrary.length); }
function videoPrev() {
  if (!videoLibrary.length) return;
  if (videoEl.currentTime > 3) { videoEl.currentTime = 0; return; }
  playVideo((currentVideoIndex - 1 + videoLibrary.length) % videoLibrary.length);
}
function handleVideoEnded() {
  if (videoLibrary.length > 1) videoNext();
  else updateVideoPlayIcon(false);
}
function updateVideoProgress() {
  if (!videoEl.duration) return;
  const pct = (videoEl.currentTime / videoEl.duration) * 100;
  document.getElementById('videoProgressFill').style.width = pct + '%';
  document.getElementById('videoProgressThumb').style.left = pct + '%';
  document.getElementById('videoCurrentTime').textContent  = formatTime(videoEl.currentTime);
}
function onVideoMeta() {
  document.getElementById('videoTotalTime').textContent = formatTime(videoEl.duration);
  updateVideoPlayIcon(true);
}
function seekVideo(e) {
  if (!videoEl.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  videoEl.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * videoEl.duration;
}
function setVideoVolume(val) { videoEl.volume = val / 100; updateVolumeSliderBg('videoVolumeSlider', val); }
function toggleVideoMute() {
  isVideoMuted = !isVideoMuted;
  videoEl.muted = isVideoMuted;
  const icon = document.getElementById('videoMuteIcon');
  if (icon) {
    icon.innerHTML = isVideoMuted
      ? `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" stroke="white" stroke-width="2" fill="none"/>
         <line x1="23" y1="9" x2="17" y2="15" stroke="white" stroke-width="2"/>
         <line x1="17" y1="9" x2="23" y2="15" stroke="white" stroke-width="2"/>`
      : `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" stroke="white" stroke-width="2" fill="none"/>
         <path d="M15.54 8.46a5 5 0 010 7.07" stroke="white" stroke-width="2" fill="none"/>`;
  }
  showToast(isVideoMuted ? '🔇 Video silenciado' : '🔊 Sonido activado');
}

function openVideoPlayer() {
  const m = document.getElementById('video-modal');
  m.classList.remove('hidden');
  setTimeout(() => m.classList.add('open'), 10);
  showVideoControls();
}
function closeVideoPlayer() {
  videoEl.pause(); updateVideoPlayIcon(false);
  const m = document.getElementById('video-modal');
  m.classList.remove('open');
  setTimeout(() => m.classList.add('hidden'), 400);
  refreshPlayingClass('video', currentVideoIndex);
}
function toggleVideoControls() {
  const c = document.getElementById('videoControls'), h = document.getElementById('videoHeader');
  const hidden = c.classList.toggle('hide');
  h.classList.toggle('hide', hidden);
  if (!hidden) { clearTimeout(videoControlsTimer); videoControlsTimer = setTimeout(hideVideoControls, 3500); }
}
function showVideoControls() {
  document.getElementById('videoControls').classList.remove('hide');
  document.getElementById('videoHeader').classList.remove('hide');
  clearTimeout(videoControlsTimer);
  videoControlsTimer = setTimeout(hideVideoControls, 3500);
}
function hideVideoControls() {
  if (!videoEl.paused) {
    document.getElementById('videoControls').classList.add('hide');
    document.getElementById('videoHeader').classList.add('hide');
  }
}
function showVideoTapIcon(playing) {
  const icon = document.getElementById('videoTapIcon');
  icon.innerHTML = playing
    ? `<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" fill="#fff"/><rect x="14" y="4" width="4" height="16" fill="#fff"/></svg>`
    : `<svg viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21" fill="#fff"/></svg>`;
  icon.classList.add('show');
  setTimeout(() => icon.classList.remove('show'), 700);
}
function toggleVideoFullscreen() {
  const wrap = document.getElementById('videoWrap');
  const req  = wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.mozRequestFullScreen;
  const exit = document.exitFullscreen  || document.webkitExitFullscreen;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) { if (req) req.call(wrap); }
  else { if (exit) exit.call(document); }
}

videoEl.addEventListener('play',           () => updateVideoPlayIcon(true));
videoEl.addEventListener('pause',          () => { updateVideoPlayIcon(false); showVideoControls(); });
videoEl.addEventListener('timeupdate',     updateVideoProgress);
videoEl.addEventListener('ended',          handleVideoEnded);
videoEl.addEventListener('loadedmetadata', onVideoMeta);
videoEl.addEventListener('error',          () => showToast('Error al reproducir el video'));

/* ── REPRODUCCIÓN ONLINE ─────────────────── */
const onlineAudio = document.getElementById('onlineAudioEl');
let currentOnlineType = ''; // 'radio' | 'youtube'

function buildRadioGrid() {
  document.getElementById('radioGrid').innerHTML = PRESET_RADIOS.map((r, i) =>
    `<div class="radio-card" onclick="playPresetRadio(${i})">
      <div class="radio-card-name">${esc(r.name)}</div>
      <div class="radio-card-genre">${esc(r.genre)}</div>
    </div>`
  ).join('');
}

function playRadio() {
  const url = document.getElementById('radioUrl').value.trim();
  if (!url) { showToast('Escribe la URL de la radio'); return; }
  startOnlineRadio(url, 'Radio Web', url);
}

function playPresetRadio(idx) {
  const r = PRESET_RADIOS[idx];
  startOnlineRadio(r.url, r.name, r.genre);
}

function startOnlineRadio(url, name, sub) {
  stopOnline();
  currentOnlineType = 'radio';
  onlineAudio.src = url;
  onlineAudio.play()
    .then(() => {
      onlinePlaying = true;
      showOnlinePlayer(name, sub);
      updateOnlinePlayIcon(true);
      showToast(`📻 ${name}`);
    })
    .catch(() => showToast('No se pudo conectar a la radio. Verifica la URL.'));
}

function playYoutube() {
  const url = document.getElementById('youtubeUrl').value.trim();
  if (!url) { showToast('Escribe la URL de YouTube'); return; }

  // Extraer video ID
  let videoId = '';
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) videoId = u.searchParams.get('v') || '';
    if (u.hostname === 'youtu.be') videoId = u.pathname.slice(1);
  } catch(e) { showToast('URL inválida'); return; }

  if (!videoId) { showToast('No se encontró el ID del video'); return; }

  stopOnline();
  currentOnlineType = 'youtube';

  // Mostrar iframe de YouTube embebido
  showOnlinePlayer('YouTube', url);
  const playerDiv = document.getElementById('onlinePlayer');

  // Agregar iframe
  let iframe = document.getElementById('ytIframe');
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.id = 'ytIframe';
    iframe.style.cssText = 'width:100%;aspect-ratio:16/9;border:none;border-radius:12px;margin-top:12px;';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    playerDiv.insertBefore(iframe, playerDiv.querySelector('.online-vol-row'));
  }
  iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;
  iframe.style.display = 'block';
  document.getElementById('onlinePlayBtn').style.display  = 'none';

  document.getElementById('onlineTrackName').textContent = 'YouTube';
  document.getElementById('onlineTrackSub').textContent  = videoId;
  onlinePlaying = true;
}

function setYoutubeExample(url) {
  document.getElementById('youtubeUrl').value = url;
}

function showOnlinePlayer(name, sub) {
  document.getElementById('onlineTrackName').textContent = name;
  document.getElementById('onlineTrackSub').textContent  = sub;
  document.getElementById('onlinePlayer').style.display  = 'block';
  document.getElementById('onlinePlayBtn').style.display = 'flex';
}

function toggleOnlinePlay() {
  if (currentOnlineType === 'radio') {
    if (onlineAudio.paused) {
      onlineAudio.play().then(() => { onlinePlaying = true; updateOnlinePlayIcon(true); }).catch(() => {});
    } else {
      onlineAudio.pause(); onlinePlaying = false; updateOnlinePlayIcon(false);
    }
  }
}

function stopOnline() {
  onlineAudio.pause(); onlineAudio.src = ''; onlinePlaying = false;
  updateOnlinePlayIcon(false);
  const iframe = document.getElementById('ytIframe');
  if (iframe) { iframe.src = ''; iframe.style.display = 'none'; }
  document.getElementById('onlinePlayer').style.display = 'none';
  currentOnlineType = '';
}

function updateOnlinePlayIcon(playing) {
  const icon = document.getElementById('onlinePlayIcon');
  if (!icon) return;
  icon.innerHTML = playing
    ? `<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>`
    : `<polygon points="5,3 19,12 5,21" fill="currentColor"/>`;
}

function setOnlineVolume(val) {
  onlineAudio.volume = val / 100;
  updateVolumeSliderBg('onlineVolumeSlider', val);
}

/* ── FAVORITOS ───────────────────────────── */
function toggleFavorite(index, type) {
  if (index < 0) return;
  const key = `${type}_${index}`;
  if (favorites.has(key)) favorites.delete(key);
  else favorites.add(key);
  const isFav = favorites.has(key);

  if (type === 'audio' && index === currentTrackIndex) {
    document.getElementById('favBtn')?.classList.toggle('active', isFav);
    const path = document.getElementById('favBtn')?.querySelector('path');
    if (path) path.setAttribute('fill', isFav ? 'var(--accent)' : 'none');
  }
  if (type === 'video' && index === currentVideoIndex) {
    document.getElementById('videoFavBtn')?.classList.toggle('active', isFav);
  }
  document.querySelectorAll(`[data-fav-idx="${index}"][data-fav-type="${type}"]`).forEach(btn => {
    btn.classList.toggle('active', isFav);
    const path = btn.querySelector('path');
    if (path) path.setAttribute('fill', isFav ? 'var(--accent)' : 'none');
  });
  renderFavorites(); updateStats(); saveState();
}
function toggleFavoriteContext() { toggleFavorite(contextTrackIndex, contextType); hideContext(); }

/* ── INDICADORES VISUALES ────────────────── */
function refreshPlayingClass(type, activeIdx) {
  if (type === 'audio') {
    document.querySelectorAll('#song-list .song-item[data-idx]').forEach(el => {
      const idx = +el.dataset.idx;
      el.classList.toggle('playing', idx === activeIdx);
      const numEl = el.querySelector('.song-num');
      if (numEl) {
        if (idx === activeIdx) {
          numEl.innerHTML = '<div class="song-playing-bars"><div class="sp-bar"></div><div class="sp-bar"></div><div class="sp-bar"></div></div>';
        } else {
          const pos = Array.from(document.querySelectorAll('#song-list .song-item')).indexOf(el) + 1;
          numEl.textContent = pos;
        }
      }
    });
  }
  if (type === 'video') {
    document.querySelectorAll('#video-list .video-card[data-vid-idx]').forEach(el => {
      el.classList.toggle('playing', +el.dataset.vidIdx === activeIdx);
    });
  }
}

/* ── UI AUDIO PLAYER ─────────────────────── */
function setPlayingUI(playing) {
  const pause = `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`;
  const play  = `<polygon points="5,3 19,12 5,21" fill="white"/>`;
  document.getElementById('playIcon').innerHTML     = playing ? pause : play;
  document.getElementById('miniPlayIcon').innerHTML = playing ? pause : play;
  document.getElementById('albumArt').classList.toggle('playing', playing);
  refreshPlayingClass('audio', currentTrackIndex);
}
function updatePlayerUI(track) {
  document.getElementById('playerTitle').textContent  = track.title;
  document.getElementById('playerArtist').textContent = track.artist;
  document.getElementById('playerFormat').textContent = `${track.format} · ${track.sizeLabel}`;
  const isFav = favorites.has('audio_' + currentTrackIndex);
  const favBtn = document.getElementById('favBtn');
  favBtn?.classList.toggle('active', isFav);
  const path = favBtn?.querySelector('path');
  if (path) path.setAttribute('fill', isFav ? 'var(--accent)' : 'none');
  const h1 = Math.floor(Math.random()*360), h2 = (h1+120)%360;
  document.getElementById('playerBg').style.background =
    `linear-gradient(135deg,hsl(${h1},55%,18%),hsl(${h2},55%,10%))`;
}
function updateMiniPlayer(track) {
  document.getElementById('miniTitle').textContent  = track.title;
  document.getElementById('miniArtist').textContent = track.artist;
}
function updateProgress() {
  if (!audioEl.duration) return;
  const pct = (audioEl.currentTime / audioEl.duration) * 100;
  document.getElementById('progressFill').style.width    = pct + '%';
  document.getElementById('progressThumb').style.left    = pct + '%';
  document.getElementById('miniProgressBar').style.width = pct + '%';
  document.getElementById('currentTime').textContent     = formatTime(audioEl.currentTime);
}
function updateTotalTime(dur) { document.getElementById('totalTime').textContent = formatTime(dur); }

/* ── VISTAS ──────────────────────────────── */
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.querySelector(`[data-view="${name}"]`).classList.add('active');
  if (name === 'favorites') renderFavorites();
  if (name === 'videos')    renderVideos();
  if (name === 'playlists') renderPlaylists();
}

/* ── MODALES AUDIO PLAYER ────────────────── */
function openPlayer() {
  if (currentTrackIndex < 0) return;
  const m = document.getElementById('player-modal');
  m.classList.remove('hidden');
  setTimeout(() => m.classList.add('open'), 10);
}
function closePlayer() {
  const m = document.getElementById('player-modal');
  m.classList.remove('open');
  setTimeout(() => m.classList.add('hidden'), 400);
}

/* ── MENÚ CONTEXTUAL ─────────────────────── */
function showContext(e, index, type) {
  e.preventDefault();
  contextTrackIndex = index; contextType = type;
  const isFav = favorites.has(`${type}_${index}`);
  document.getElementById('favContextLabel').textContent = isFav ? 'Quitar de favoritos' : 'Agregar a favoritos';
  const menu = document.getElementById('context-menu');
  menu.classList.remove('hidden');
  menu.style.left = Math.min(e.clientX, window.innerWidth  - 220) + 'px';
  menu.style.top  = Math.min(e.clientY, window.innerHeight - 180) + 'px';
}
function hideContext() { document.getElementById('context-menu').classList.add('hidden'); contextTrackIndex = -1; }
document.addEventListener('click', e => { if (!e.target.closest('.context-menu')) hideContext(); });

function shareTrack() {
  const item = contextType === 'audio' ? library[contextTrackIndex] : videoLibrary[contextTrackIndex];
  if (item && navigator.share) navigator.share({ title: item.title, text: item.title });
  else showToast('Compartir no disponible');
  hideContext();
}
function showTrackInfo() {
  const item = contextType === 'audio' ? library[contextTrackIndex] : videoLibrary[contextTrackIndex];
  if (!item) return;
  const rows = [['Tipo', contextType==='audio'?'Audio':'Video'],['Título',item.title],['Formato',item.format],['Tamaño',item.sizeLabel],['Archivo',item.name]];
  if (contextType==='audio') rows.splice(2,0,['Artista',item.artist]);
  document.getElementById('info-content').innerHTML = rows.map(([k,v]) =>
    `<div class="info-row"><span class="info-label">${k}</span><span class="info-val">${esc(String(v))}</span></div>`
  ).join('');
  document.getElementById('info-modal').classList.remove('hidden');
  hideContext();
}
function closeInfoModal() { document.getElementById('info-modal').classList.add('hidden'); }

/* ── CONFIGURACIÓN ───────────────────────── */
function clearLibrary() {
  if (!confirm('¿Limpiar toda la biblioteca (audio y video)?')) return;
  library = []; videoLibrary = []; favorites = new Set(); playlists = [];
  currentTrackIndex = -1; currentVideoIndex = -1;
  audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load();
  document.getElementById('mini-player').classList.add('hidden');
  renderLibrary(); renderVideos(); renderFavorites(); renderPlaylists();
  updateStats(); saveState(); showToast('Biblioteca limpiada');
}
function updateStats() {
  document.getElementById('totalSongs').textContent     = library.length;
  document.getElementById('totalVideos').textContent    = videoLibrary.length;
  document.getElementById('totalPlaylists').textContent = playlists.length;
  document.getElementById('totalFavs').textContent      = favorites.size;
}
function updateVolumeSliderBg(id, val) {
  const el = document.getElementById(id);
  if (el) el.style.background = `linear-gradient(to right, var(--primary) 0%, var(--secondary) ${val}%, var(--bg-3) ${val}%)`;
}

/* ── PERSISTENCIA ────────────────────────── */
function saveState() {
  try {
    localStorage.setItem('kingaplay_state', JSON.stringify({
      library:      library.map(t => ({...t, url:null})),
      videoLibrary: videoLibrary.map(v => ({...v, url:null})),
      favorites:    [...favorites],
      playlists,
      currentTrackIndex, currentVideoIndex,
    }));
  } catch(e) {}
}
function loadState() {
  try {
    const raw = localStorage.getItem('kingaplay_state');
    if (!raw) return;
    const d = JSON.parse(raw);
    favorites = new Set(d.favorites || []);
    playlists = d.playlists || [];
    renderLibrary(); renderVideos(); renderFavorites(); renderPlaylists();
    updateStats();
  } catch(e) {}
}

/* ── HELPERS ─────────────────────────────── */
function formatTime(s) {
  if (!s || isNaN(s) || !isFinite(s)) return '0:00';
  return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
}
function formatBytes(b) {
  if (!b) return '—';
  return b<1048576 ? (b/1024).toFixed(0)+' KB' : (b/1048576).toFixed(1)+' MB';
}
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── TOAST ───────────────────────────────── */
let toastTimer;
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div'); el.id = 'toast';
    el.style.cssText = 'position:fixed;bottom:calc(var(--nav-h) + var(--player-h) + 16px);left:50%;transform:translateX(-50%) translateY(20px);background:var(--bg-2);border:1px solid var(--border);color:var(--text-1);padding:10px 20px;border-radius:20px;font-family:var(--font-display);font-size:0.82rem;z-index:9000;opacity:0;transition:all 0.3s;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,0.5);pointer-events:none;max-width:80vw;text-overflow:ellipsis;overflow:hidden;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity='1'; el.style.transform='translateX(-50%) translateY(0)';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateX(-50%) translateY(10px)'; },2500);
}

/* ── GESTOS ──────────────────────────────── */
['player-modal','video-modal'].forEach(id => {
  let startY = 0;
  const el = document.getElementById(id);
  el.addEventListener('touchstart', e => { startY = e.touches[0].clientY; }, {passive:true});
  el.addEventListener('touchmove',  e => {
    if (e.touches[0].clientY - startY > 90) {
      id === 'player-modal' ? closePlayer() : closeVideoPlayer();
    }
  }, {passive:true});
});

/* ── SERVICE WORKER ──────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(()=>{}));
}
