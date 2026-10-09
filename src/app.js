/**
 * OB Transfer - Futuristic File Transfer Client
 * (c) 2026 Bibek Bista
 */
import confetti from 'canvas-confetti';

import { MAX_CONCURRENT_UPLOADS, MAX_FILE_SIZE } from './modules/constants.js';
import { state } from './modules/state.js';
import { el } from './modules/dom.js';
import { api } from './modules/api.js';

const ui = { search: '', authBusy: false };

// --- Initialization ---
function init() {
    setupEventListeners();
    createParticles();
    checkAuth();
}

// --- Authentication ---
async function checkAuth() {
    try {
        const response = await api.session();

        if (response.ok) {
            el.authOverlay.classList.add('hidden');
            setupSocket();
            await fetchFiles();
            return;
        }

        el.authOverlay.classList.remove('hidden');
    } catch (err) {
        el.authOverlay.classList.remove('hidden');
        showToast('SYSTEM ERROR', 'Authentication server unreachable.', 'error');
    }
}

async function handleLogin(e) {
    if (e) e.preventDefault();
    const password = el.accessKey.value;
    el.authError.classList.add('hidden');
    if (!password) {
        el.authError.textContent = 'Enter the access password.';
        el.authError.classList.remove('hidden');
        el.accessKey.focus();
        return;
    }
    setAuthBusy(true);

    try {
        const response = await api.login(password);

        if (response.ok) {
            el.accessKey.value = '';
            el.authOverlay.classList.add('hidden');
            showToast('ACCESS GRANTED', 'Secure session established.', 'success');
            setupSocket();
            await fetchFiles();
        } else {
            el.accessKey.value = '';
            el.authError.textContent = response.status === 429
                ? 'Too many failed attempts. Please try again later.'
                : 'Invalid access key.';
            el.authError.classList.remove('hidden');
        }
    } catch (err) {
        showToast('SYSTEM ERROR', 'Authentication server unreachable.', 'error');
    } finally {
        setAuthBusy(false);
    }
}

function setAuthBusy(busy) {
    ui.authBusy = busy;
    const button = document.getElementById('authSubmitBtn');
    if (!button) return;
    button.disabled = busy;
    const label = button.querySelector('.auth-submit-label');
    if (label) label.textContent = busy ? 'Verifying…' : 'Enter OB Transfer';
}

// --- Socket.IO ---
function setupSocket() {
    // io is loaded globally from the script tag in index.html
    state.socket = window.io();
    
    state.socket.on('connect', () => {
        el.socketStatus.style.backgroundColor = '#00ff9c';
        el.socketStatus.classList.remove('bg-red-500');
        el.socketStatus.classList.add('bg-[#00ff9c]');
        el.socketText.textContent = 'Operational';
        el.socketText.className = 'text-[10px] uppercase tracking-widest text-[#00ff9c]';
    });
    
    state.socket.on('connect_error', (error) => {
        if (error && error.message === 'Unauthorized') {
            el.authOverlay.classList.remove('hidden');
            showToast('SESSION EXPIRED', 'Please authenticate again.', 'warning');
        }
    });

    state.socket.on('disconnect', () => {
        el.socketStatus.style.backgroundColor = '#ef4444';
        el.socketStatus.classList.remove('bg-[#00ff9c]');
        el.socketStatus.classList.add('bg-red-500');
        el.socketText.textContent = 'Disconnected';
        el.socketText.className = 'text-[10px] uppercase tracking-widest text-red-500';
    });

    state.socket.on('file:uploaded', (file) => {
        const exists = state.files.find(f => f.id === file.id);
        if (!exists) {
            state.files.unshift(file);
            renderFileList();
            showToast('NEW ASSET DETECTED', `${file.originalName} synced across nodes.`, 'info');
        }
    });

    state.socket.on('file:deleted', ({ id }) => {
        state.files = state.files.filter(f => f.id !== id);
        renderFileList();
    });
}

// --- File Operations ---
function switchView(view) {
    if (view === 'explorer') {
        el.viewExplorer.classList.remove('hidden');
        el.viewTransfers.classList.add('hidden');
        el.navExplorer.classList.add('text-[#00ff9c]');
        el.navExplorer.classList.remove('text-gray-500');
        el.navTransfers.classList.add('text-gray-500');
        el.navTransfers.classList.remove('text-[#00ff9c]');
    } else {
        el.viewExplorer.classList.add('hidden');
        el.viewTransfers.classList.remove('hidden');
        el.navTransfers.classList.add('text-[#00ff9c]');
        el.navTransfers.classList.remove('text-gray-500');
        el.navExplorer.classList.add('text-gray-500');
        el.navExplorer.classList.remove('text-[#00ff9c]');
    }
}

async function fetchFiles() {
    el.fileLoading?.classList.remove('hidden');
    try {
        const res = await api.files();
        
        if (res.status === 401) {
            el.authOverlay.classList.remove('hidden');
            return;
        }
        
        state.files = await res.json();
        renderFileList();
    } catch (err) {
        console.error('Failed to fetch files:', err);
        showToast('NETWORK ERROR', 'Could not sync with central cluster.', 'error');
    } finally {
        el.fileLoading?.classList.add('hidden');
    }
}

function renderFileList() {
    el.fileList.innerHTML = '';
    
    const count = document.getElementById('fileCount');
    const storage = document.getElementById('storageUsed');
    if (count) count.textContent = state.files.length.toLocaleString();
    if (storage) storage.textContent = formatBytes(state.files.reduce((total, file) => total + Number(file.fileSize || 0), 0));

    if (state.files.length === 0) {
        el.emptyState.classList.remove('hidden');
        return;
    } else {
        el.emptyState.classList.add('hidden');
    }

    const query = ui.search.trim().toLowerCase();
    const visibleFiles = query
        ? state.files.filter(file => String(file.originalName || '').toLowerCase().includes(query) || String(file.extension || '').toLowerCase().includes(query))
        : state.files;

    if (visibleFiles.length === 0) {
        el.emptyState.classList.remove('hidden');
        el.emptyState.querySelector('h3').textContent = query ? 'No Matches' : 'No Files Yet';
        el.emptyState.querySelector('p').textContent = query ? 'Try a different filename or extension.' : 'Your transfer library is empty. Add a file to get started.';
        return;
    }

    el.emptyState.classList.add('hidden');
    visibleFiles.forEach(file => {
        const card = createFileCard(file);
        el.fileList.appendChild(card);
    });

}

function createFileCard(file) {
    const div = document.createElement('div');
    div.className = 'mobile-card flex items-center gap-4 group cursor-pointer active:scale-[0.99] transition-all';
    div.tabIndex = 0;
    div.setAttribute('role', 'button');
    div.setAttribute('aria-label', `Preview ${file.originalName || 'file'}`);

    const ext = (file.extension || 'bin').replace('.', '');
    const dateStr = new Date(file.uploadDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const size = formatBytes(file.fileSize);

    const iconWrap = document.createElement('div');
    iconWrap.className = 'w-12 h-12 bg-white/5 rounded-2xl flex items-center justify-center shrink-0 border border-white/5 group-hover:border-[#00ff9c]/30 transition-colors';
    const iconHolder = document.createElement('div');
    iconHolder.innerHTML = getFileIcon(ext); // application-owned static SVG only
    iconWrap.appendChild(iconHolder);

    const content = document.createElement('div');
    content.className = 'flex-grow min-w-0';
    const name = document.createElement('h4');
    name.className = 'font-bold text-sm truncate uppercase tracking-tight group-hover:text-[#00ff9c] transition-colors';
    name.textContent = file.originalName || 'Unnamed file';
    const meta = document.createElement('div');
    meta.className = 'flex items-center gap-2 mt-0.5';
    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'text-[10px] text-gray-500 font-mono uppercase';
    sizeSpan.textContent = size;
    const dot = document.createElement('span');
    dot.className = 'w-1 h-1 rounded-full bg-white/10';
    const dateSpan = document.createElement('span');
    dateSpan.className = 'text-[10px] text-gray-500 font-mono uppercase';
    dateSpan.textContent = dateStr;
    meta.append(sizeSpan, dot, dateSpan);
    content.append(name, meta);

    const arrow = document.createElement('div');
    arrow.className = 'p-2 text-gray-700';
    arrow.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" /></svg>';
    div.append(iconWrap, content, arrow);
    const open = () => openPreview(file);
    div.addEventListener('click', open);
    div.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
    return div;
}

function addToQueue(files) {
    Array.from(files).forEach(file => {
        if (file.size > MAX_FILE_SIZE) {
            showToast('LIMIT EXCEEDED', `${file.name} is too large. Max 10GB.`, 'error');
            return;
        }

        const id = crypto.randomUUID();
        const queueItem = {
            id,
            file,
            status: 'queued',
            progress: 0,
            speed: 0,
            eta: null,
            startTime: null,
            xhr: null
        };
        
        state.uploadQueue.push(queueItem);
    });
    renderQueue();
    switchView('transfers');
}

function renderQueue() {
    const count = state.uploadQueue.filter(i => i.status === 'uploading' || i.status === 'queued').length;
    if (count > 0) {
        el.transferCount.textContent = count;
        el.transferCount.classList.remove('hidden');
        el.queueEmptyState.classList.add('hidden');
    } else {
        el.transferCount.classList.add('hidden');
        el.queueEmptyState.classList.remove('hidden');
    }

    // Remove old items from DOM
    const currentQueueIds = state.uploadQueue.map(i => i.id);
    Array.from(el.uploadQueue.children).forEach(child => {
        if (!currentQueueIds.includes(child.dataset.id)) {
            child.style.opacity = '0';
            child.style.transform = 'translateY(-10px) scale(0.95)';
            setTimeout(() => child.remove(), 400); // Wait for transition
        }
    });

    state.uploadQueue.forEach((item, index) => {
        let div = Array.from(el.uploadQueue.children).find(child => child.dataset.id === item.id) || null;
        
        const statusColors = {
            'queued': 'bg-gray-700 text-white',
            'uploading': 'bg-cyan-500 text-cyan-50',
            'completed': 'bg-[#00ff9c] text-black shadow-[0_0_15px_rgba(0,255,156,0.3)]',
            'failed': 'bg-red-600 text-white shadow-[0_0_15px_rgba(255,0,0,0.3)]',
            'paused': 'bg-yellow-600 text-white'
        };

        const speedText = item.status === 'uploading' && item.speed ? `${formatBytes(item.speed)}/s` : '';
        const etaText = item.status === 'uploading' && item.eta ? item.eta : '';
        const shimmerClass = item.status === 'uploading' ? 'shimmering' : '';
        const glowClass = item.status === 'completed' ? 'success-glow border-[#00ff9c]/50' : 'border-white/10';
        const progressClass = item.status === 'completed' ? 'progress-success' : '';
        const iconHtml = item.status === 'completed' ? `<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>` : getFileIcon(item.file.name.split('.').pop());

        if (!div) {
            // Create new item
            div = document.createElement('div');
            div.dataset.id = item.id;
            div.className = `queue-item p-5 rounded-[2rem] bg-[#0a0f1c]/60 border flex items-center gap-5 group/item transition-all duration-500 transform scale-95 opacity-0 translate-y-4 backdrop-blur-md relative overflow-hidden`;
            
            // Inset HTML structure
            div.innerHTML = `
                <div class="absolute inset-0 bg-gradient-to-r from-white/[0.02] to-transparent pointer-events-none"></div>
                <div class="absolute inset-0 glow-layer hidden opacity-0 transition-opacity duration-1000 bg-[radial-gradient(ellipse_at_left,_var(--tw-gradient-stops))] from-[#00ff9c]/10 via-transparent to-transparent pointer-events-none z-0"></div>
                <div class="absolute top-0 right-0 w-32 h-full bg-gradient-to-l from-white/[0.05] to-transparent opacity-0 group-hover/item:opacity-100 transition-opacity duration-500 pointer-events-none"></div>

                <div class="icon-container relative z-10 w-14 h-14 rounded-[1.25rem] flex items-center justify-center shrink-0 transition-all duration-500 overflow-hidden bg-black text-white shadow-xl">
                    <div class="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent"></div>
                    <div class="relative z-10 icon-svg"></div>
                </div>
                <div class="flex-grow min-w-0 transition-all z-10">
                    <div class="flex justify-between items-center mb-3">
                        <p class="text-[13px] font-bold truncate pr-4 text-white file-name-display tracking-wide"></p>
                        <span class="status-badge text-[9px] font-black uppercase px-3 py-1.5 rounded-full transition-all duration-500 shadow-sm border border-transparent"></span>
                    </div>
                    <div class="h-2 bg-black/50 rounded-full overflow-hidden relative shadow-inner">
                        <div class="progress-bar-inner h-full absolute left-0 top-0 transition-all duration-300 rounded-full" style="width: 0%"></div>
                    </div>
                    
                    <div class="flex justify-between mt-4 items-center">
                        <div class="flex gap-4">
                            <div class="flex items-center gap-2 bg-black/30 px-3 py-1.5 rounded-xl border border-white/5">
                                <span class="progress-text text-[11px] font-black text-white font-mono tracking-wider"></span>
                                <span class="w-[3px] h-[3px] rounded-full bg-white/20 hidden size-display-sep"></span>
                                <span class="size-text text-[10px] font-bold text-gray-500 font-mono uppercase tracking-widest hidden"></span>
                            </div>
                            <div class="speed-container flex items-center gap-2 bg-cyan-900/20 px-3 py-1.5 rounded-xl border border-cyan-500/20 hidden transition-all duration-300">
                                <div class="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(34,211,238,0.8)]"></div>
                                <p class="speed-text text-[10px] text-cyan-400 font-black uppercase font-mono tracking-widest"></p>
                            </div>
                        </div>
                        
                        <div class="eta-container flex items-center gap-3 bg-white/5 px-4 py-1.5 rounded-xl border border-white/10 hidden transition-all duration-300 shadow-sm">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <div class="flex flex-col justify-center">
                                <span class="text-[7px] text-gray-400 font-black uppercase tracking-[0.25em] leading-none mb-1">Estimated</span>
                                <span class="eta-text text-[11px] text-gray-200 font-black uppercase font-mono leading-none tracking-wider"></span>
                            </div>
                        </div>
                    </div>
                </div>
                <button class="remove-btn relative z-10 w-12 h-12 flex items-center justify-center text-gray-500 hover:text-red-400 transition-all hover:bg-red-500/10 rounded-2xl group border border-transparent hover:border-red-500/20">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            `;
            el.uploadQueue.appendChild(div);

            // Trigger entrance animation next frame
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    div.style.opacity = '1';
                    div.style.transform = 'translateY(0) scale(1)';
                    // Stagger entering based on index
                    div.style.transitionDelay = `${Math.min(index * 50, 300)}ms`;
                });
            });
            
            // Clean up transition delay after entrance
            setTimeout(() => {
                div.style.transitionDelay = '0ms';
            }, 500);
        }

        // Update elements
        div.className = `queue-item p-5 rounded-[2rem] bg-[#0a0f1c]/60 border flex items-center gap-5 group/item transition-all duration-500 transform scale-100 opacity-100 translate-y-0 backdrop-blur-md relative overflow-hidden ${glowClass} ${
            item.status === 'uploading' ? 'shadow-[0_10px_40px_rgba(0,0,0,0.4)] border-cyan-500/20 bg-[#0a0f1c]/80' : ''
        }`;

        const glowLayer = div.querySelector('.glow-layer');
        if (item.status === 'uploading') {
            glowLayer.classList.remove('hidden', 'opacity-0');
            glowLayer.classList.add('opacity-100', 'from-cyan-500/10');
        } else if (item.status === 'completed') {
            glowLayer.classList.remove('hidden', 'opacity-0', 'from-cyan-500/10');
            glowLayer.classList.add('opacity-100', 'from-[#00ff9c]/10');
        } else {
            glowLayer.classList.add('hidden', 'opacity-0');
        }

        const iconContainer = div.querySelector('.icon-container');
        const iconSvg = div.querySelector('.icon-svg');
        iconSvg.innerHTML = iconHtml;
        iconContainer.className = `icon-container relative z-10 w-14 h-14 rounded-[1.25rem] flex items-center justify-center shrink-0 transition-all duration-500 overflow-hidden shadow-xl ${
            item.status === 'completed' ? 'bg-[#00ff9c]/10 text-[#00ff9c] border border-[#00ff9c]/30 shadow-[0_0_20px_rgba(0,255,156,0.3)]' : 
            item.status === 'uploading' ? 'bg-cyan-900/40 text-cyan-400 border border-cyan-500/40 shadow-[0_0_20px_rgba(34,211,238,0.3)] animate-pulse' : 
            item.status === 'failed' ? 'bg-red-900/30 text-red-400 border border-red-500/30' : 
            item.status === 'retrying' ? 'bg-amber-900/30 text-amber-500 border border-amber-500/30' : 'bg-black text-gray-400 border border-white/5'
        }`;

        div.querySelector('.file-name-display').textContent = item.file.name;
        
        const badge = div.querySelector('.status-badge');
        badge.className = `status-badge text-[9px] font-black uppercase px-3 py-1.5 rounded-full transition-all duration-500 shadow-sm border tracking-widest ${
            item.status === 'completed' ? 'text-black bg-[#00ff9c] shadow-[0_0_15px_rgba(0,255,156,0.5)] border-transparent' :
            item.status === 'uploading' ? 'text-cyan-50 bg-cyan-500 shadow-[0_0_15px_rgba(34,211,238,0.5)] border-transparent' :
            item.status === 'failed' ? 'text-white bg-red-600 shadow-[0_0_15px_rgba(220,38,38,0.5)] border-transparent' :
            item.status === 'retrying' ? 'text-amber-500 bg-amber-500/20 shadow-[0_0_15px_rgba(245,158,11,0.3)] border-transparent' :
            'text-gray-300 bg-black/50 border-white/10'
        }`;
        badge.textContent = item.status === 'retrying' ? `RETRYING (${item.retries}/2)` : item.status;

        const progressBarInner = div.querySelector('.progress-bar-inner');
        progressBarInner.className = `progress-bar-inner h-full absolute left-0 top-0 transition-all duration-300 rounded-full ${shimmerClass} ${progressClass}`;
        
        if (item.status === 'uploading') {
            progressBarInner.style.background = 'linear-gradient(90deg, #00d4ff, #00ff9c)';
            progressBarInner.style.width = `${item.progress}%`;
        } else if (item.status === 'completed') {
            progressBarInner.style.width = `100%`;
        } else {
            progressBarInner.style.background = 'rgba(255,255,255,0.2)';
            progressBarInner.style.width = `${item.progress}%`;
        }

        div.querySelector('.progress-text').textContent = `${item.progress}%`;
        
        const sizeText = div.querySelector('.size-text');
        const sizeSep = div.querySelector('.size-display-sep');
        
        if (item.status === 'queued' || item.status === 'completed' || item.status === 'failed' || item.status === 'retrying') {
            sizeText.textContent = formatBytes(item.file.size);
            sizeText.classList.remove('hidden');
            sizeSep.classList.remove('hidden');
        } else {
            sizeText.classList.add('hidden');
            sizeSep.classList.add('hidden');
        }

        const speedContainer = div.querySelector('.speed-container');
        if (speedText) {
            speedContainer.classList.remove('hidden');
            div.querySelector('.speed-text').textContent = speedText;
        } else {
            speedContainer.classList.add('hidden');
        }

        const etaContainer = div.querySelector('.eta-container');
        if (etaText) {
            etaContainer.classList.remove('hidden');
            div.querySelector('.eta-text').textContent = etaText;
        } else {
            etaContainer.classList.add('hidden');
        }
    });
}

function processQueue() {
    if (state.activeUploads >= MAX_CONCURRENT_UPLOADS) return;
    
    const nextItem = state.uploadQueue.find(item => item.status === 'queued');
    if (!nextItem) return;

    nextItem.status = 'uploading';
    nextItem.startTime = Date.now();
    state.activeUploads++;
    renderQueue();

    uploadFile(nextItem);
    processQueue(); // Try to start more if possible
}

function uploadFile(item) {
    if (!item || !item.file) return;

    const formData = new FormData();
    formData.append('file', item.file);

    const xhr = new XMLHttpRequest();
    item.xhr = xhr;

    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && item.startTime) {
            const now = Date.now();
            const percent = Math.round((e.loaded / e.total) * 100);
            const elapsedOverall = (now - item.startTime) / 1000;
            const elapsedSinceLast = (now - (item.lastTime || item.startTime)) / 1000;
            const bytesSinceLast = e.loaded - (item.lastLoaded || 0);
            
            item.progress = percent;

            // Only update speed/ETA every 0.5s for UI stability
            if (elapsedSinceLast >= 0.5) {
                const instantSpeed = bytesSinceLast / elapsedSinceLast;
                // Exponential moving average for smoothness (alpha = 0.3)
                item.speed = item.speed ? (item.speed * 0.7 + instantSpeed * 0.3) : instantSpeed;
                
                const remainingBytes = e.total - e.loaded;
                const remainingSeconds = item.speed > 0 ? remainingBytes / item.speed : (e.total - e.loaded) / (e.loaded / elapsedOverall);
                item.eta = formatDuration(remainingSeconds);

                item.lastTime = now;
                item.lastLoaded = e.loaded;
                renderQueue();
            } else if (percent !== item.lastPercent) {
                // Still update percent visually even if speed isn't updated
                item.lastPercent = percent;
                renderQueue();
            }
        }
    });

    xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
            item.status = 'completed';
            item.progress = 100;
            showToast('UPLINK SUCCESSFUL', `${item.file.name} deployed.`, 'success');
            triggerConfetti();
        } else {
            handleFailure(`Error transferring ${item.file.name}.`);
            return;
        }
        
        state.activeUploads--;
        renderQueue();
        
        // Auto-remove completed items from queue after some time
        if (item.status === 'completed') {
            setTimeout(() => {
                state.uploadQueue = state.uploadQueue.filter(i => i.id !== item.id);
                renderQueue();
            }, 3000);
        }

        processQueue();
    });

    xhr.addEventListener('error', () => {
        handleFailure(`Uplink severed for ${item.file.name}.`);
    });

    function handleFailure(errorMsg) {
        if ((item.retries || 0) < 2) {
            item.retries = (item.retries || 0) + 1;
            item.status = 'retrying';
            const delay = Math.pow(2, item.retries - 1) * 2000;
            showToast('CONNECTION RETRYING', `Retrying ${item.file.name} in ${delay/1000}s...`, 'warning');
            setTimeout(() => {
                if (item.status === 'retrying') {
                    item.status = 'queued';
                    renderQueue();
                    processQueue();
                }
            }, delay);
        } else {
            item.status = 'failed';
            showToast('UPLINK FAILED', errorMsg, 'error');
        }
        state.activeUploads--;
        renderQueue();
        processQueue();
    }

    xhr.open('POST', '/api/upload');
    xhr.send(formData);
}

// --- Preview Modal ---
let visualizerInterval = null;

function openPreview(file) {
    const modal = el.previewModal;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    requestAnimationFrame(() => {
        modal.classList.add('active');
        el.modalContent.style.opacity = '1';
        el.modalContent.style.transform = 'translateY(0)';
    });

    const container = el.mediaContainer;
    container.replaceChildren();

    document.getElementById('previewName').textContent = file.originalName || 'Unnamed file';
    document.getElementById('previewSize').textContent = formatBytes(file.fileSize);
    document.getElementById('previewDate').textContent = new Date(file.uploadDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    document.getElementById('previewMime').textContent = file.mimeType || 'application/octet-stream';
    document.getElementById('previewExt').textContent = (file.extension || '').toUpperCase();
    document.getElementById('previewId').textContent = file.id;
    document.getElementById('previewStoredName').textContent = file.storedName;

    const viewUrl = `/api/files/${file.id}/view`;
    const downloadUrl = `/api/files/${file.id}/download`;
    document.getElementById('downloadBtn').href = downloadUrl;
    document.getElementById('deleteBtn').onclick = () => deleteFile(file.id);

    if (visualizerInterval) clearInterval(visualizerInterval);
    const type = String(file.mimeType || '').split('/')[0];

    switch(type) {
        case 'video': {
            const wrapper = document.createElement('div');
            wrapper.className = 'w-full h-full flex items-center justify-center bg-black rounded-xl overflow-hidden group';
            const video = document.createElement('video');
            video.id = 'obTransferPlayer';
            video.src = viewUrl;
            video.className = 'w-full h-full max-h-[85vh] object-contain';
            video.controls = true;
            video.playsInline = true;
            video.autoplay = true;
            video.preload = 'auto';
            wrapper.appendChild(video);
            container.appendChild(wrapper);
            setTimeout(() => video.play().catch(e => console.log('Autoplay blocked:', e)), 50);
            break;
        }
        case 'image': {
            const wrapper = document.createElement('div');
            wrapper.className = 'relative w-full h-full flex items-center justify-center overflow-hidden';
            const blur = document.createElement('div');
            blur.className = 'zoom-blur-bg';
            blur.style.backgroundImage = `url("${viewUrl}")`;
            const image = document.createElement('img');
            image.src = viewUrl;
            image.className = 'media-preview-image shadow-[0_30px_60px_-15px_rgba(0,0,0,0.7)] rounded-xl z-10';
            image.alt = file.originalName || 'File preview';
            wrapper.append(blur, image);
            container.appendChild(wrapper);
            break;
        }
        case 'audio': {
            const card = document.createElement('div');
            card.className = 'audio-card glass-panel animate-revealer';
            card.innerHTML = `
                <div class="w-20 h-20 bg-[#00ff9c]/10 rounded-full flex items-center justify-center border border-[#00ff9c]/20 animate-pulse">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-[#00ff9c]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" /></svg>
                </div>
                <div id="visualizer" class="visualizer-container"></div>
                <audio id="obTransferAudio" controls class="w-full"></audio>
                <p class="text-[10px] font-mono text-[#00ff9c]/40 uppercase tracking-[0.4em]">Audio Frequency Stabilizer Active</p>
            `;
            const visualizer = card.querySelector('#visualizer');
            for (let i = 0; i < 32; i++) {
                const bar = document.createElement('div');
                bar.className = 'visualizer-bar';
                visualizer.appendChild(bar);
            }
            card.querySelector('#obTransferAudio').src = viewUrl;
            container.appendChild(card);
            startVisualizer();
            break;
        }
        default: {
            const wrapper = document.createElement('div');
            wrapper.className = 'flex flex-col items-center gap-8 p-12 glass-panel rounded-[3rem] border border-white/5';
            const icon = document.createElement('div');
            icon.className = 'w-32 h-32 bg-white/5 rounded-[2.5rem] border border-white/10 flex items-center justify-center shadow-inner';
            icon.innerHTML = getFileIcon(file.extension); // application-owned static SVG only
            const text = document.createElement('div');
            text.className = 'text-center space-y-2';
            const title = document.createElement('h3');
            title.className = 'text-xl font-bold uppercase tracking-tighter';
            title.textContent = 'Format Unrecognised';
            const desc = document.createElement('p');
            desc.className = 'text-gray-500 font-mono text-[10px] uppercase tracking-widest';
            desc.textContent = 'Protocol mismatch: Direct rendering restricted';
            text.append(title, desc);
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.className = 'px-8 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-[10px] font-black uppercase tracking-widest transition-all';
            link.textContent = 'Download Local Copy';
            wrapper.append(icon, text, link);
            container.appendChild(wrapper);
            break;
        }
    }
}

function startVisualizer() {
    const audio = document.getElementById('obTransferAudio');
    const bars = document.querySelectorAll('.visualizer-bar');
    if (!audio || bars.length === 0) return;

    visualizerInterval = setInterval(() => {
        if (!audio.paused) {
            bars.forEach(bar => {
                const height = Math.random() * 100;
                bar.style.height = `${Math.max(10, height)}%`;
                bar.style.opacity = 0.3 + (height / 100) * 0.7;
            });
        } else {
            bars.forEach(bar => {
                bar.style.height = '4px';
                bar.style.opacity = '0.3';
            });
        }
    }, 100);
}

function closePreview() {
    const modal = el.previewModal;
    modal.classList.remove('active');
    el.modalContent.style.opacity = '0';
    el.modalContent.style.transform = 'translateY(12px)';
    document.body.style.overflow = '';
    
    if (visualizerInterval) {
        clearInterval(visualizerInterval);
        visualizerInterval = null;
    }

    // Stop audio/video playback immediately
    const video = document.getElementById('obTransferPlayer');
    const audio = document.getElementById('obTransferAudio');
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }

    setTimeout(() => {
        modal.classList.add('hidden');
        el.mediaContainer.innerHTML = '';
    }, 500);
}

async function deleteFile(id) {
    if (!confirm('Are you sure you want to purge this record from history?')) return;

    try {
        const res = await api.deleteFile(id);
        
        if (res.ok) {
            closePreview();
            showToast('ASSET PURGED', 'File successfully erased from system memory.', 'warning');
        } else {
            showToast('ACCESS DENIED', 'Failed to purge restricted asset.', 'error');
        }
    } catch (err) {
        showToast('CRITICAL FAILURE', 'Deletion uplink interrupted.', 'error');
    }
}

// --- Utils ---
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '---';
    if (seconds < 1) return 'NEARLY DONE';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.round(seconds % 60);

    if (hours > 0) {
        return `${hours}H ${mins}M`;
    }
    if (mins > 0) {
        return `${mins}M ${secs}S`;
    }
    return `${secs}S`;
}

function getFileIcon(ext) {
    ext = (ext || '').toLowerCase().replace('.', '');
    const videos = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
    const images = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    const audio = ['mp3', 'wav', 'ogg'];

    if (videos.includes(ext)) {
        return `<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>`;
    }
    if (images.includes(ext)) {
        return `<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6 text-[#00ff9c]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>`;
    }
    if (audio.includes(ext)) {
        return `<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" /></svg>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6 text-gray-400 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>`;
}

function showToast(title, message, type = 'info') {
    const div = document.createElement('div');
    const bg = {
        success: 'bg-[#00ff9c]/10 border-[#00ff9c]/20 text-[#00ff9c]',
        error: 'bg-red-500/10 border-red-500/20 text-red-500',
        warning: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-500',
        info: 'bg-blue-500/10 border-blue-500/20 text-blue-500'
    }[type] || 'bg-blue-500/10 border-blue-500/20 text-blue-500';

    div.className = `toast-item w-80 p-5 rounded-2xl border backdrop-blur-xl ${bg} glass-panel shadow-2xl flex gap-4 pointer-events-auto`;
    const content = document.createElement('div');
    content.className = 'flex-grow';
    const heading = document.createElement('h5');
    heading.className = 'text-[10px] font-black uppercase tracking-[0.2em] mb-1 truncate';
    heading.textContent = title;
    const body = document.createElement('p');
    body.className = 'text-[13px] opacity-80 leading-tight';
    body.textContent = message;
    content.append(heading, body);
    div.appendChild(content);

    el.toastRegistry.appendChild(div);
    setTimeout(() => {
        div.style.transform = 'translateX(120%)';
        div.style.opacity = '0';
        setTimeout(() => div.remove(), 600);
    }, 6000);
}

function createParticles() {
    const container = document.querySelector('.particles-container');
    if (!container) return;
    for (let i = 0; i < 50; i++) {
        const point = document.createElement('div');
        point.className = 'point';
        point.style.left = `${Math.random() * 100}%`;
        point.style.top = `${Math.random() * 100}%`;
        point.style.width = `${Math.random() * 3}px`;
        point.style.height = point.style.width;
        point.style.opacity = Math.random() * 0.4;
        container.appendChild(point);
    }
}

function triggerConfetti() {
    if (typeof confetti !== 'function') return;

    const end = Date.now() + 2 * 1000;
    const colors = ['#00ff9c', '#00d4ff', '#8b5cf6', '#ffffff'];

    // Initial big burst
    confetti({
        particleCount: 100,
        spread: 100,
        origin: { y: 0.6 },
        colors: colors,
        zIndex: 2000,
        disableForReducedMotion: true
    });

    // Sustained smaller bursts
    (function frame() {
        confetti({
            particleCount: 6,
            angle: 60,
            spread: 55,
            origin: { x: 0, y: 0.7 },
            colors: colors,
            zIndex: 2000,
            disableForReducedMotion: true
        });
        confetti({
            particleCount: 6,
            angle: 120,
            spread: 55,
            origin: { x: 1, y: 0.7 },
            colors: colors,
            zIndex: 2000,
            disableForReducedMotion: true
        });

        if (Date.now() < end) {
            requestAnimationFrame(frame);
        }
    }());
}

// --- Event Listeners ---
function setupEventListeners() {
    el.fabBtn.addEventListener('click', () => el.fileInput.click());
    
    el.navExplorer.addEventListener('click', () => switchView('explorer'));
    el.navTransfers.addEventListener('click', () => switchView('transfers'));

    const search = document.getElementById('fileSearch');
    search?.addEventListener('input', (event) => {
        ui.search = event.target.value;
        renderFileList();
    });

    const refresh = document.getElementById('refreshBtn');
    refresh?.addEventListener('click', async () => {
        refresh.disabled = true;
        refresh.classList.add('is-spinning');
        await fetchFiles();
        refresh.disabled = false;
        refresh.classList.remove('is-spinning');
    });

    el.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            addToQueue(e.target.files);
            // Auto start if queue was empty? No, prompt says don't auto start.
        }
        el.fileInput.value = '';
    });

    // Global Drag & Drop Handlers
    let dragCounter = 0;

    document.body.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        if (dragCounter === 1) {
            el.dragDropOverlay.classList.remove('opacity-0', 'pointer-events-none');
            el.dragDropContent.classList.remove('scale-95');
            el.dragDropContent.classList.add('scale-100');
        }
    });

    document.body.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    document.body.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter === 0) {
            el.dragDropOverlay.classList.add('opacity-0', 'pointer-events-none');
            el.dragDropContent.classList.remove('scale-100');
            el.dragDropContent.classList.add('scale-95');
        }
    });

    document.body.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        el.dragDropOverlay.classList.add('opacity-0', 'pointer-events-none');
        el.dragDropContent.classList.remove('scale-100');
        el.dragDropContent.classList.add('scale-95');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            addToQueue(e.dataTransfer.files);
            switchView('transfers'); // Switch to transfer view on drop
        }
    });

    el.startAllBtn.addEventListener('click', processQueue);
    el.clearQueueBtn.addEventListener('click', () => {
        state.uploadQueue = state.uploadQueue.filter(item => item.status === 'uploading');
        renderQueue();
    });

    el.authForm.addEventListener('submit', handleLogin);
    el.modalBackdrop.addEventListener('click', closePreview);
    el.closeModalBtn.addEventListener('click', closePreview);

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closePreview();
    });

    el.uploadQueue.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.remove-btn');
        if (removeBtn) {
            const id = removeBtn.dataset.id;
            const item = state.uploadQueue.find(i => i.id === id);
            if (item && item.xhr) item.xhr.abort();
            state.uploadQueue = state.uploadQueue.filter(i => i.id !== id);
            renderQueue();
        }
    });
}

// Start the app
document.addEventListener('DOMContentLoaded', init);
