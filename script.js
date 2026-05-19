/* ════════════════════════════════════════════════════════════════
   script.js  –  eSports Dashboard – Ranking Dinâmico do Top 5 Kills
   ════════════════════════════════════════════════════════════════ */

'use strict';

// Carrega o Color Thief via módulo de CDN de forma assíncrona
import('https://cdnjs.cloudflare.com/ajax/libs/color-thief/2.3.0/color-thief.mjs');

// ─── Configuração ───────────────────────────────────────────────
const SHEET_ID = '1PNRlqwXiHPPzQSN6S57gtJrl92D_3YKwIn1kg98Eyhg';

const SHEET_GID_MAP = {
  '2024 FFWS BR SPLIT 2': '1670285599',
  '2025 FFWS BR SPLIT 2': '0',
  '2026 COPA FF': '1751570302',
  '2026 FFWS BR SPLIT 1': '646625412',
};

// Cache e timers
const dataCache = {};
const playersCache = {}; 
let debounceTimer = null;
let suggestionsDebounceTimer = null;

// Elementos do DOM
const elInputPlayer      = document.getElementById('inputPlayer');
const elSplitLeftTitle   = document.getElementById('split-left-title');
const elSuggestionsPopup = document.getElementById('suggestions-popup');
const elSuggestionsList  = document.getElementById('suggestions-list');
const elLoadingOverlay   = document.getElementById('loading-overlay');

// Inicialização automática do Ranking
document.addEventListener('DOMContentLoaded', () => {
  loadTopKillersRanking();
});

// Gatilho para atualizar o ranking ao editar a competição
window.triggerRankingUpdate = function() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    loadTopKillersRanking();
  }, 1000);
};

// ════════════════════════════════════════════════════════════════
// GERENCIADOR DE MÍDIA CENTRALIZADO (FOTOS E LOGOS - CORRIGIDO)
// ════════════════════════════════════════════════════════════════
window.processarUploadImagem = function(side, tipo) {
  const fileInput = document.getElementById(`upload-${tipo}-${side}`);
  const file = fileInput?.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const base64Img = e.target.result;
    
    if (tipo === 'logo') {
      const imgBg = document.getElementById(`logo-bg-${side}`);
      if (imgBg) { 
        imgBg.src = base64Img; 
        imgBg.style.display = 'block'; 
      }
      aplicarCoresPorLogo(base64Img);
    } else if (tipo === 'avatar') {
      // Procura pelo ID dinâmico corrigido (ex: avatar-left, avatar-p2, etc.)
      const targetImg = document.getElementById(`avatar-${side}`);
      if (targetImg) {
        targetImg.src = base64Img;
      }
    }
  };
  reader.readAsDataURL(file);
};

function aplicarCoresPorLogo(imageSrc) {
  const imgTemp = new Image();
  imgTemp.src = imageSrc;
  imgTemp.crossOrigin = 'Anonymous';
  imgTemp.onload = function() {
    try {
      const colorThief = new ColorThief();
      const [r, g, b] = colorThief.getColor(imgTemp);
      const card = document.getElementById('card-left');
      if (card) {
        card.style.background = `linear-gradient(135deg, rgba(${r}, ${g}, ${b}, 0.35) 0%, rgba(0, 0, 0, 0.9) 100%)`;
        card.style.borderColor = `rgba(${r}, ${g}, ${b}, 0.6)`;
      }
    } catch (e) { console.log("ColorThief ignorado ou bloqueado localmente:", e); }
  };
}

// ════════════════════════════════════════════════════════════════
// EXTRAÇÃO E ORDENAÇÃO DO TOP 5 DE ABATES DO SHEET
// ════════════════════════════════════════════════════════════════
async function loadTopKillersRanking() {
  showLoading(true);
  const sheetName = elSplitLeftTitle.textContent.trim();
  const gid = resolveSheetGid(sheetName);
  
  const query = encodeURIComponent(`SELECT *`);
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${gid}&tq=${query}`;

  try {
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const json = JSON.parse(text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, ''));
    const rows = json?.table?.rows ?? [];

    const totalPlayers = rows.map(row => {
      const cells = row.c ?? [];
      return {
        jogador: cells[0]?.v ?? '—',
        equipe: cells[1]?.v ?? '—',
        quedas: cells[2]?.v !== null ? Number(cells[2]?.v) : 0,
        abates: cells[3]?.v !== null ? Number(cells[3]?.v) : 0
      };
    }).filter(p => p.jogador && p.jogador !== '—');

    // Ordena por Abates (Maior para Menor)
    totalPlayers.sort((a, b) => b.abates - a.abates);

    const top5 = totalPlayers.slice(0, 5);

    for (let i = 0; i < 5; i++) {
      const pos = i + 1;
      const playerData = top5[i] || { jogador: '—', equipe: '—', abates: '—', quedas: '—' };
      
      if (pos === 1) {
        setText('r-player-name-1', playerData.jogador);
        setText('r-team-1', playerData.equipe);
        setText('r-abates-1', playerData.abates);
        setText('r-quedas-1', playerData.quedas);
        
        const avatar = document.getElementById('avatar-left');
        if (avatar && (avatar.src.includes('ui-avatars.com') || avatar.src === '' || avatar.src.includes('placeholder'))) {
          avatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(playerData.jogador)}&background=0d1117&color=fff&size=128`;
        }
      } else {
        setText(`r-player-name-${pos}`, playerData.jogador);
        setText(`r-abates-${pos}`, playerData.abates);
        setText(`r-quedas-${pos}`, playerData.quedas);
      }
    }

  } catch (err) {
    console.error("Falha ao computar ranking do Sheets: ", err);
    showToast("Erro ao processar dados de kills do Sheets.");
  } finally {
    showLoading(false);
  }
}

// ════════════════════════════════════════════════════════════════
// ENGINE DE BUSCA DE JOGADORES (MANTIDO)
// ════════════════════════════════════════════════════════════════
window.syncName = function() {
  const player = elInputPlayer.value.trim();
  const sheetName = elSplitLeftTitle.textContent.trim();

  clearTimeout(suggestionsDebounceTimer);
  suggestionsDebounceTimer = setTimeout(async () => {
    if (player.length >= 2) {
      const players = await fetchAllPlayersFromSheet(sheetName);
      const scored = players.map(p => ({ ...p, score: similarityScore(player, p.jogador) }));
      const filtered = scored.filter(p => p.score > 0.3).sort((a, b) => b.score - a.score).slice(0, 6);
      
      if (filtered.length > 0) {
        elSuggestionsList.innerHTML = filtered.map(sug => `
          <li class="suggestion-item" style="padding:10px; cursor:pointer;" onclick="selectSuggestion('${sug.jogador}')">
            <strong>${sug.jogador}</strong> - ${sug.equipe || '—'}
          </li>
        `).join('');
        elSuggestionsPopup.classList.remove('hidden');
      } else {
        elSuggestionsPopup.classList.add('hidden');
      }
    } else {
      elSuggestionsPopup.classList.add('hidden');
    }
  }, 200);
};

window.selectSuggestion = function(playerName) {
  elInputPlayer.value = playerName;
  elSuggestionsPopup.classList.add('hidden');
  showToast(`Jogador selecionado: ${playerName}`);
};

async function fetchAllPlayersFromSheet(sheetName) {
  const cacheKey = `ALL_${sheetName.toUpperCase()}`;
  if (playersCache[cacheKey]) return playersCache[cacheKey];
  const gid = resolveSheetGid(sheetName);
  const query = encodeURIComponent(`SELECT A, B`);
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${gid}&tq=${query}`;
  try {
    const resp = await fetch(url);
    const text = await resp.text();
    const json = JSON.parse(text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, ''));
    const rows = json?.table?.rows ?? [];
    const res = rows.map(r => ({ jogador: r.c[0]?.v, equipe: r.c[1]?.v })).filter(p => p.jogador);
    playersCache[cacheKey] = res;
    return res;
  } catch(e) { return []; }
}

function levenshteinDistance(str1, str2) {
  const len1 = str1.length, len2 = str2.length;
  const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(0));
  for (let i = 0; i <= len1; i++) matrix[0][i] = i;
  for (let j = 0; j <= len2; j++) matrix[j][0] = j;
  for (let j = 1; j <= len2; j++) {
    for (let i = 1; i <= len1; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(matrix[j][i - 1] + 1, matrix[j - 1][i] + 1, matrix[j - 1][i - 1] + indicator);
    }
  }
  return matrix[len2][len1];
}

function similarityScore(str1, str2) {
  const s1 = str1.toLowerCase(), s2 = str2.toLowerCase();
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  const maxLen = Math.max(s1.length, s2.length);
  return 1 - (levenshteinDistance(s1, s2) / maxLen);
}

function resolveSheetGid(sheetName) {
  if (!sheetName) return '0';
  if (SHEET_GID_MAP[sheetName] !== undefined) return SHEET_GID_MAP[sheetName];
  const lower = sheetName.toLowerCase();
  for (const [k, v] of Object.entries(SHEET_GID_MAP)) {
    if (k.toLowerCase() === lower) return v;
  }
  return '0';
}

function setText(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }
function showLoading(show) { elLoadingOverlay.classList.toggle('hidden', !show); }
function showToast(msg) {
  const old = document.querySelector('.toast'); if(old) old.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
}
