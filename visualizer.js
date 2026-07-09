const CONFIG = {
    API_BASE: 'http://localhost:8000', 
};

// --- 1. CORE RADAR & PLAYBACK CONFIGURATION ---
const CANVAS_SIZE = 1024;
let animationFrameId = null;
let playbackStartTime = null;
let pausedTimeOffset = 0; // Tracks elapsed time before pausing
let isPlaying = false;
const MS_PER_FRAME = 250; // 16 ticks at 64Hz = exactly 250ms per data index

//could be removed out of globalscope since it's used once for the player selection grid, but leaving it here for now
let globalPlayerList = [];

const trajectoryCache = new Map();
const MAX_CACHED_PLAYERS = 20;

const canvas = document.getElementById('radarCanvas');
const ctx = canvas.getContext('2d');
const mapBackground = new Image();

// State variables
let trajectoryData = []; // Pure array of filtered rounds returned by the backend query
let roundFrameCounters = {};
let grenadeData = [];

// Helper function to load payload data into global state variables
function loadPayloadIntoState(payload) {
    trajectoryData = payload.trajectories;
    grenadeData = payload.grenades || [];
    // Find this inside loadPayloadIntoState:
    if (payload.available_maps) {
        updateMapDropdown(payload.available_maps);
    }

    const targetMapImage = payload.map_name === 'all' ? 'de_mirage' : payload.map_name;
    mapBackground.src = `maps/${targetMapImage}.png`;
    window.activeDetonations = {}; 

    isPlaying = false; // Optional: Force pause on switch
    pausedTimeOffset = 0; // 🚀 RESET THIS
    playbackStartTime = 0; // 🚀 RESET THIS
    
    // 2. Update UI button to reflect the reset state
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.innerText = "Play";

    // 3. Clear existing animation frame to prevent doubling up
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    roundFrameCounters = {};
    trajectoryData.forEach((round, index) => {
        roundFrameCounters[index] = 0; 
    });

    document.getElementById('matchMeta').innerText = 
        `Loaded ${trajectoryData.length} relevant round paths on ${payload.map_name.toUpperCase()} (Cached)`;

    if (mapBackground.complete) {
        drawFrameAt(0, 0);
    } else {
        mapBackground.onload = () => drawFrameAt(0, 0);
    }
}

function getFromCache(key) {
    if (!trajectoryCache.has(key)) return null;
    
    // LRU Trick: Read the value, delete it, and re-set it. 
    // This moves it to the "newest" end of the Map's insertion order.
    const data = trajectoryCache.get(key);
    trajectoryCache.delete(key);
    trajectoryCache.set(key, data);
    return data;
}

function saveToCache(key, payload) {
    // If it already exists, remove it first so we can overwrite its position
    if (trajectoryCache.has(key)) {
        trajectoryCache.delete(key);
    }
    
    trajectoryCache.set(key, payload);

    // --- LRU EVICTION ENGINE ---
    // Extract unique SteamIDs currently taking up space in our keys
    const uniquePlayers = new Set();
    for (const cacheKey of trajectoryCache.keys()) {
        const steamid = cacheKey.split('_')[0];
        uniquePlayers.add(steamid);
    }

    // If we have broken past our player ceiling, evict the oldest entry
    if (uniquePlayers.size > MAX_CACHED_PLAYERS) {
        // The first key in a Map iterator is strictly the oldest inserted/accessed item
        const oldestKeyToEvict = trajectoryCache.keys().next().value;
        const evictedSteamId = oldestKeyToEvict.split('_')[0];
        
        // Evict ALL sub-keys belonging to that specific player to completely scrub their 2MB footprint
        for (const cacheKey of Array.from(trajectoryCache.keys())) {
            if (cacheKey.startsWith(evictedSteamId)) {
                trajectoryCache.delete(cacheKey);
            }
        }
        
        console.log(`🧹 LRU Eviction: Max player limit (${MAX_CACHED_PLAYERS}) reached. Completely purged player ${evictedSteamId} from browser RAM.`);
    }
}

// Distinct colors for different rounds when rendering overlays
const ROUND_COLORS = [
    '#ff4b4b', '#4bffff', '#ade55c', '#ffea00', '#ff8400', 
    '#e040fb', '#00e676', '#ff1744', '#1de9b6', '#f50057',
    '#3d5afe', '#00b0ff', '#76ff03', '#f4ff81', '#ffb300'
];

function lerp(start, end, progress) {
    return start + (end - start) * progress;
}

function lerpAngle(start, end, progress) {
    let difference = end - start;
    
    // Normalize difference to (-180, 180]
    while (difference < -180) difference += 360;
    while (difference > 180)  difference -= 360;
    
    return start + difference * progress;
}

// Generates the selection matrix interface dynamically using only active characters
function initializeCharacterGrid() {
    const gridContainer = document.getElementById('charIndexGrid');
    if (!gridContainer) return;
    
    gridContainer.innerHTML = ''; 
    
    const activeCharsSet = new Set();
    globalPlayerList.forEach(player => {
        if (player.name && player.name.trim().length > 0) {
            const firstChar = player.name.trim().charAt(0).toUpperCase();
            activeCharsSet.add(firstChar);
        }
    });

    const activeCharacters = Array.from(activeCharsSet).sort((a, b) => {
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
    
    activeCharacters.forEach(char => {
        const btn = document.createElement('button');
        btn.className = 'char-btn';
        btn.type = 'button';
        btn.innerText = char;
        btn.onclick = () => filterPlayersByChar(char, btn);
        gridContainer.appendChild(btn);
    });

    if (activeCharacters.length === 0) {
        gridContainer.innerHTML = '<span class="placeholder-text">No active players found in dataset.</span>';
    }
}

// Filters cached memory targets based on the selected letter/number
function filterPlayersByChar(char, targetButton) {
    document.querySelectorAll('.char-btn').forEach(b => b.classList.remove('active'));
    targetButton.classList.add('active');
    
    const resultsContainer = document.getElementById('playerResultsContainer');
    if (!resultsContainer) return;
    
    resultsContainer.innerHTML = ''; 
    
    const filtered = globalPlayerList.filter(player => {
        if (!player.name) return false;
        return player.name.trim().toUpperCase().startsWith(char);
    });
    
    if (filtered.length === 0) {
        resultsContainer.innerHTML = `<span class="placeholder-text">No players found starting with "${char}"</span>`;
        return;
    }
    
    filtered.forEach(player => {
        const pBtn = document.createElement('button');
        pBtn.className = 'player-tag-btn';
        pBtn.type = 'button';
        pBtn.innerText = player.name;
        
        pBtn.onclick = () => {
            document.querySelectorAll('.player-tag-btn').forEach(b => b.classList.remove('active'));
            pBtn.classList.add('active');
            document.getElementById('playerSelect').value = player.steamid;

            const activeSteamId = player.steamid;

            // Call your query with global flags to pull everything into the smart cache in one trip
            triggerDatabaseQuery(activeSteamId, 'all');
        };
        
        resultsContainer.appendChild(pBtn);
    });
}

// --- 2. INITIALIZATION ROUTINES ---
async function init() {
    // 🚀 FIXED: The () => {} wrapper prevents the 'event' object from being passed
    document.getElementById('sideSelect').addEventListener('change', () => {
        // Get the current values from the UI
        const steamid = document.getElementById('playerSelect').value;
        const side = document.getElementById('sideSelect').value;
        
        // Explicitly call the query with resolved values
        triggerDatabaseQuery(steamid, side);
    });
    document.getElementById('mapSelect').addEventListener('change', () => {
        const steamid = document.getElementById('playerSelect').value;
        const side = document.getElementById('sideSelect').value;
        const map = document.getElementById('mapSelect').value;
        
        // 1. Construct the key we used to save this slice earlier
        const cacheKey = `${steamid}`;
        const cachedData = getFromCache(cacheKey);

        if (cachedData && cachedData.maps[map]) {
            // 2. 🚀 THIS IS THE KEY: Manually trigger the state loader
            // This updates the map image, the trajectoryData, and the animation loop
            console.log(`✅ Cache Hit for: ${cacheKey}`); // 🚀 Log it!
            const mapSlice = {
                map_name: map,
                available_maps: cachedData.available_maps,
                trajectories: cachedData.maps[map].trajectories,
                grenades: cachedData.maps[map].grenades
            };
            loadPayloadIntoState(mapSlice);
        } else {
            // If it's not in cache, fetch it
            console.log(`📡 Cache Miss, fetching: ${cacheKey}`); // 🚀 Log it!
            triggerDatabaseQuery(steamid, side);
        }
    });

    document.getElementById('playPauseBtn').addEventListener('click', togglePlayback);
    
    try {
        const response = await fetch(new URL('/api/filters', CONFIG.API_BASE));
        if (!response.ok) throw new Error("Could not fetch database filter metadata.");
        const filters = await response.json();

        globalPlayerList = filters.players || [];
        initializeCharacterGrid();
        
        /*
        const mapSelect = document.getElementById('mapSelect');
        filters.maps.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m; opt.innerText = m;
            mapSelect.appendChild(opt);
        });
        */

        triggerDatabaseQuery();

    } catch (err) {
        console.error("Initialization failed:", err);
        document.getElementById('matchMeta').innerText = "❌ Failed to connect to local API metadata server.";
    }
}

// Helper to keep drawing code dry when dealing with empty data arrays
function renderEmptyWarningState(playerName, mapText, sideText) {
    document.getElementById('matchMeta').innerHTML = 
        `<span style="color: #ef4444; font-weight: bold;">⚠️ No tracking paths found for ${playerName} on ${mapText} (${sideText})</span>`;
    
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    drawGrid(); 
    
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)'; 
    ctx.strokeStyle = '#ef4444'; 
    ctx.lineWidth = 2;
    
    const boxWidth = 600; const boxHeight = 100;
    const boxX = (CANVAS_SIZE - boxWidth) / 2; const boxY = (CANVAS_SIZE - boxHeight) / 2;
    
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 8); 
    ctx.fill(); ctx.stroke();
    
    ctx.fillStyle = '#ef4444'; 
    ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⚠️ NO MATCH TRAJECTORIES FOUND', CANVAS_SIZE / 2, CANVAS_SIZE / 2 - 15);
    
    ctx.fillStyle = '#cbd5e1'; 
    ctx.font = '14px sans-serif';
    ctx.fillText(`${playerName}  •  ${mapText}  •  ${sideText}`, CANVAS_SIZE / 2, CANVAS_SIZE / 2 + 18);
    ctx.restore();

    trajectoryData = [];
    grenadeData = [];
}

function updateMapDropdown(maps) {
    const mapSelect = document.getElementById('mapSelect');
    const currentVal = mapSelect.value;
    
    mapSelect.innerHTML = ''; // Clear
    
    // Sort them if you want consistency (e.g., de_ancient, de_mirage...)
    maps.sort().forEach(map => {
        const opt = document.createElement('option');
        opt.value = map;
        // Clean up the name for the user
        opt.textContent = map
        mapSelect.appendChild(opt);
    });
    
    // Keep the selection if it's still available, otherwise default to first
    if (maps.includes(currentVal)) {
        mapSelect.value = currentVal;
    } else if (maps.length > 0) {
        mapSelect.value = maps[0];
    }
}


// --- 3. DATABASE QUERY ENGINE ---
async function triggerDatabaseQuery(explicitSteamId = null, explicitSide = null) {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    // 1. Prioritize parameters, fall back to DOM elements only if they are missing
    const steamid = explicitSteamId || document.getElementById('playerSelect').value;
    const side = explicitSide || document.getElementById('sideSelect').value;
    let mapName = document.getElementById('mapSelect').value;


    const playerName = playerSelect.options ? playerSelect.options[playerSelect.selectedIndex]?.text : "Selected Player";
    const sideText = side.toUpperCase();
    const sideLower = side.toLowerCase();

    if (!steamid) {
        console.warn("Dropdowns not ready yet. Postponing query.");
        return;
    }

    // Reset baseline clock variations safely
    pausedTimeOffset = 0; 
    playbackStartTime = null;
    isPlaying = false;

    // 🚀 GENERATE UNIQUE CACHE KEY FOR THIS COMBINATION
    let cacheKey = `${steamid}`;
    let cachedData = getFromCache(cacheKey)
    let payload = null;

    // 🚀 HIT CHECK: If we already queried this, load it instantly from memory!
    if (cachedData) {
        console.log(`⚡ Cache Hit for Key: ${cacheKey}`);
        payload = cachedData;
        // If it was a cached empty/warning state, handle it immediately
        if (cachedData.isEmptyState) {
            renderEmptyWarningState(playerName, mapName);
            return;
        }
    } else {
        document.getElementById('matchMeta').innerText = "🔍 Fetching custom trajectory records from MongoDB...";
        try {
            const queryurl = new URL('/api/query', CONFIG.API_BASE);
            queryurl.search = new URLSearchParams({ 
                steamid, 
                side: 'all' 
            }).toString();

            const response = await fetch(queryurl);
            
            if (!response.ok) throw new Error("Query lookup failed.");
            payload = await response.json();

            // Check if data is empty, cache the empty state layout pattern
            if (!payload.available_maps || payload.available_maps.length === 0) {
                saveToCache(cacheKey, { isEmptyState: true });
                renderEmptyWarningState(playerName, mapText, sideText);
                return; 
            }

            // Save all 3 profile matrices into cache memory
            saveToCache(`${steamid}`, payload);
            console.log(`💾 Cached data for player ${steamid}`);

        } catch (err) {
            console.error("Query failed:", err);
            document.getElementById('matchMeta').innerText = "❌ No records found matching current parameter choices.";
        }
    }

    // 2. SLICE ON THE FLY: Dynamically filter down the cached arrays based on the active dropdown selection
    if (!mapName || !payload.available_maps.includes(mapName)) {
        mapName = payload.available_maps[0];
    }

    const rawMapData = payload.maps[mapName] || { trajectories: [], grenades: [] };

    // Filter trajectories and grenades on the fly based on 'ct', 't', or 'all'
    const filteredTrajectories = rawMapData.trajectories.filter(t => 
        sideLower === 'all' || t.side?.toLowerCase() === sideLower
    );
    
    const filteredGrenades = rawMapData.grenades ? rawMapData.grenades.filter(g => 
        sideLower === 'all' || g.side?.toLowerCase() === sideLower
    ) : [];

    const mapSlice = {
        map_name: mapName,
        available_maps: payload.available_maps,
        trajectories: filteredTrajectories,
        grenades: filteredGrenades
    };

    loadPayloadIntoState(mapSlice);


}

function togglePlayback() {

    isPlaying = !isPlaying;
    
    document.getElementById('playPauseBtn').innerText = isPlaying ? "Pause" : "Play";

    if (isPlaying) {
        playbackStartTime = performance.now() - pausedTimeOffset;
        //console.log("🎯 Loop Starting! Set playbackStartTime to:", playbackStartTime);
        animationFrameId = requestAnimationFrame(renderLoop);
    } else {
        if (playbackStartTime) {
            pausedTimeOffset = performance.now() - playbackStartTime;
        }
        //console.log("⏸️ Loop Paused! Calculated pausedTimeOffset:", pausedTimeOffset);
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
    }
}

// --- 4. DRAWING PIPELINE DECOUPLING ---
function drawText(text, x, y, font, options = {}) {
    ctx.save();
    ctx.font = font;
    ctx.textAlign = options.align || 'center';
    ctx.textBaseline = options.baseline || 'middle';
    ctx.fillStyle = options.color || '#ffffff';
    
    if (options.shadow) {
        ctx.shadowColor = options.shadowColor || 'black';
        ctx.shadowBlur = options.shadowBlur || 3;
    }
    ctx.fillText(text, x, y);
    ctx.restore();
}

// Clean helper for drawing flat/bordered canvas circles
function drawCircle(x, y, radius, fillStyle, strokeStyle = '#000000', lineWidth = 1.5) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    if (fillStyle) {
        ctx.fillStyle = fillStyle;
        ctx.fill();
    }
    if (strokeStyle) {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
    }
}
function drawFrameAt(exactFrameIndex, currentTimestamp) {
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    if (mapBackground.complete) {
        ctx.drawImage(mapBackground, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
    } else {
        drawGrid();
    }

    const currentFrameIndex = Math.floor(exactFrameIndex);
    const nextFrameIndex = currentFrameIndex + 1;
    const progress = exactFrameIndex - currentFrameIndex;
    let maxDurationReached = true;

    // 1. PROCESS PLAYER TRAJECTORIES
    trajectoryData.forEach((round, index) => {
        if (!round.coords || round.coords.length === 0) return;
        const currentSelectedSide = document.getElementById('sideSelect')?.value.toLowerCase() || 'all';
        if (currentSelectedSide !== 'all' && round.side?.toLowerCase() !== currentSelectedSide) {
            return; // Skip drawing this track entirely!
        }
        let drawX, drawY, drawYaw;

        if (currentFrameIndex < round.coords.length - 1 && round.coords[currentFrameIndex] && round.coords[nextFrameIndex]) {
            maxDurationReached = false;
            const currentFrame = round.coords[currentFrameIndex];
            const nextFrame = round.coords[nextFrameIndex];

            drawX = lerp(currentFrame[0], nextFrame[0], progress);
            drawY = lerp(currentFrame[1], nextFrame[1], progress);
            drawYaw = lerpAngle(currentFrame[2], nextFrame[2], progress);
        } else {
            const finalFrame = round.coords[round.coords.length - 1];
            if (!finalFrame) return;
            [drawX, drawY, drawYaw] = finalFrame;
        }

        const color = ROUND_COLORS[index % ROUND_COLORS.length];
        
        // Draw player node
        drawCircle(drawX, drawY, 10, color, '#000000', 1.5);

        // Draw direction vector line
        ctx.beginPath();
        ctx.moveTo(drawX, drawY);
        const rad = (drawYaw * Math.PI) / 180;
        ctx.lineTo(drawX + Math.cos(rad) * 14, drawY - Math.sin(rad) * 14);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Round Label
        //drawText(`Round ${round.round_num} (${round.side.toUpperCase()})`, drawX + 14, drawY + 4, 'bold 11px sans-serif', { align: 'left', shadow: true });
    });

    // 2. PROCESS GRENADES
    if (typeof activeDetonations === 'undefined') window.activeDetonations = {};

    grenadeData.forEach(nade => {
        if (!nade.path || nade.path.length === 0) return;
        //console.log(`[ID: ${nade.thrower}] Smoke Rendered | Round: ${nade.round_num}`);
        // 🚀 THE FIX GUARD: Skip rendering if the grenade doesn't match the active UI dropdown side choice
        // 🛡️ THE MISSING GUARD: Only draw the smoke if we have a trajectory for this player



        const currentSelectedSide = document.getElementById('sideSelect')?.value.toLowerCase() || 'all';
        if (currentSelectedSide !== 'all' && nade.side?.toLowerCase() !== currentSelectedSide) {
            return; // Skip drawing this grenade completely!
        }
        const currentRoundFrame = exactFrameIndex;
        const firstFrameIndex = Math.floor(nade.path[0][0] / 16);
        if (currentRoundFrame < firstFrameIndex) return;

        const nadeKey = `${nade.round_num}_${nade.type}_${nade.path[0][1]}_${nade.path[0][2]}`;
        const nadeTypeLower = nade.type.toLowerCase();
        const isSmoke = nadeTypeLower.includes('smoke') || nade.type.includes('CSmoke');

        const finalFrame = nade.path[nade.path.length - 1];
        const finalFrameIndex = Math.floor(finalFrame[0] / 16);
        const isDetonated = currentRoundFrame >= finalFrameIndex;

        let nadeX, nadeY;
        const currentFrameIdx = nade.path.findIndex(f => Math.floor(f[0] / 16) >= currentRoundFrame);

        if (!isDetonated && currentFrameIdx > 0 && currentFrameIdx < nade.path.length) {
            const pFrame = nade.path[currentFrameIdx - 1];
            const nFrame = nade.path[currentFrameIdx];
            const pFrameTime = Math.floor(pFrame[0] / 16);
            const nFrameTime = Math.floor(nFrame[0] / 16);
            const segmentProgress = nFrameTime !== pFrameTime ? (currentRoundFrame - pFrameTime) / (nFrameTime - pFrameTime) : 0;

            nadeX = lerp(pFrame[1], nFrame[1], segmentProgress);
            nadeY = lerp(pFrame[2], nFrame[2], segmentProgress);
        } else {
            const currentFrame = nade.path.find(f => Math.floor(f[0] / 16) >= currentRoundFrame);
            [nadeX, nadeY] = currentFrame ? [currentFrame[1], currentFrame[2]] : [finalFrame[1], finalFrame[2]];
        }

        if (nadeX === undefined || nadeY === undefined) return;

        // Post-Detonation Render (Lingering Emojis)
        if (isDetonated && !isSmoke) {
            if (!activeDetonations[nadeKey]) activeDetonations[nadeKey] = currentTimestamp;
            const detElapsedMs = currentTimestamp - activeDetonations[nadeKey];

            let displayDuration = 2000, emoji = "";
            if (nadeTypeLower.includes('hegrenade') || nade.type.includes('CHEGrenade')) return; // HE pops instantly, skip rendering lingering emoji
            
            if (nadeTypeLower.includes('molo') || nade.type.includes('CMolotov') || nadeTypeLower.includes('incen')) {
                displayDuration = nadeTypeLower.includes('incen') ? 5000 : 7000;
                emoji = "🔥";
            } else if (nadeTypeLower.includes('flash') || nade.type.includes('CFlashbang')) {
                displayDuration = 500;
                emoji = "⚡";
            }

            if (emoji && detElapsedMs < displayDuration) {
                drawText(emoji, nadeX, nadeY, "22px Arial");
            }
            return;
        }

        // Mid-Air / Live Grenade Render
        if (isSmoke) {
    // 1. Draw the circle as you were
    drawCircle(nadeX, nadeY, 14, '#94a3b8', '#000000', 1.5);
    ctx.globalAlpha = 0.5; ctx.fill(); ctx.globalAlpha = 1.0;
    if (isDetonated) drawText("💨", nadeX, nadeY, "14px Arial");

} else if (!isDetonated) {
            if (nadeTypeLower.includes('hegrenade') || nade.type.includes('CHE')) {
                drawText("💣", nadeX, nadeY, "16px Arial");
            } else {
                const nadeColor = (nadeTypeLower.includes('molo') || nadeTypeLower.includes('incen') || nade.type.includes('CMolotov')) ? '#f97316' : '#ffffff';
                drawCircle(nadeX, nadeY, 5, nadeColor, '#000000', 1.5);
            }
        }
    });

    const elapsedSeconds = (exactFrameIndex * MS_PER_FRAME) / 1000;
    document.getElementById('timeDisplay').innerText = `Time: ${elapsedSeconds.toFixed(2)}s | tracks: ${trajectoryData.length}`;

    return maxDurationReached;
}

// --- 5. ANIMATION STREAM LOOP WRAPPER ---
function renderLoop(timestamp) {
    if (!isPlaying){
        //console.log("🛑 renderLoop rejected frame: isPlaying is FALSE");
        return;
    } 

    if (!playbackStartTime){
        //console.log("⏰ Clock initialized inside loop to timestamp:", timestamp);
        playbackStartTime = timestamp;
    }
    const elapsedMs = Math.max(0, timestamp - playbackStartTime);
    const exactFrameIndex = elapsedMs / MS_PER_FRAME;
    //console.log(`🎬 Frame Tick -> elapsedMs: ${elapsedMs.toFixed(1)} | exactFrameIndex: ${exactFrameIndex.toFixed(2)}`);
    // Execute drawing pipeline
    const maxDurationReached = drawFrameAt(exactFrameIndex, timestamp);

    if (!maxDurationReached) {
        animationFrameId = requestAnimationFrame(renderLoop);
    } else {
        // 🏁 Max duration reached. Auto-stopping.
        console.log("🏁 Max duration reached. Resetting.");
        
        isPlaying = false;
        animationFrameId = null;
        
        // 🚀 THE FIX: Reset the clock variables
        playbackStartTime = null; 
        pausedTimeOffset = 0;
        
        // Update UI
        document.getElementById('playPauseBtn').innerText = "Play";
        
        // OPTIONAL: Snap back to the very first frame visually
        drawFrameAt(0, performance.now());
    }
}

function drawGrid() {
    ctx.strokeStyle = '#1e222b';
    ctx.lineWidth = 1;
    for (let i = 0; i < CANVAS_SIZE; i += 64) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, CANVAS_SIZE); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(CANVAS_SIZE, i); ctx.stroke();
    }
}

window.onload = init;