/* ════════════════════════════════════════════════════════════════
   script.js  –  eSports Dashboard – Integração Google Sheets
   ════════════════════════════════════════════════════════════════

   ARQUITETURA
   ───────────
   • fetchGoogleSheetData(playerName, sheetName)
       Consulta a Google Visualization API filtrando pelo nome do
       jogador (coluna A) na aba identificada por sheetName (que
       funciona como identificador de Split/Temporada).

   • fetchAllPlayersFromSheet(sheetName)
       Busca TODOS os jogadores de uma aba para fazer fuzzy search
       e sugerir nomes similares.

   • Cache inteligente: chave "PLAYER_SPLIT" (ex: "YAGO_SPLIT1")
       Evita requisições repetidas ao alternar entre os mesmos
       jogadores/splits já consultados.

   • syncName()
       Gatilho unificado chamado a cada oninput no campo de busca
       (#inputPlayer) e nos títulos de split editáveis.
       Dispara Promise.all() com duas buscas paralelas e atualiza
       todo o dashboard em seguida.

   PLANILHA
   ────────
   ID: 1PNRlqwXiHPPzQSN6S57gtJrl92D_3YKwIn1kg98Eyhg
   Colunas (por posição): A=Jogador B=Equipe C=Quedas D=Abates
                          E=Capas F=Derrubados G=Gelos
                          H=Gelos Destruídos I=Reviveu J=Aliados Revividos

   NOTA: A coluna de Split/Temporada não existe na planilha atual.
   O mecanismo usa o nome da aba (sheet) como identificador do split.
   Cada temporada deve ser uma aba separada na planilha.
   ════════════════════════════════════════════════════════════════ */

'use strict';

// ─── Configuração ───────────────────────────────────────────────
const SHEET_ID = '1PNRlqwXiHPPzQSN6S57gtJrl92D_3YKwIn1kg98Eyhg';

/**
 * Mapeamento de nome de aba (como digitado pelo usuário no split-title)
 * para o gid numérico da aba no Google Sheets.
 * Adicione mais abas conforme necessário.
 *
 * Como descobrir o gid: abra a planilha, clique na aba desejada e
 * observe o parâmetro "gid=XXXXXXXX" na URL.
 */
const SHEET_GID_MAP = {
  // Chave: nome exato da aba (case-insensitive, aplicado no lookup)
  // Valor: gid numérico
  '2024 FFWS BR SPLIT 2': '1670285599',
  '2025 FFWS BR SPLIT 2': '0',
  '2026 COPA FF': '1751570302',
  '2026 FFWS BR SPLIT 1': '646625412',
};

// ─── Cache de dados (chave: "PLAYER_SPLIT") ─────────────────────
const dataCache = {};
const playersCache = {}; // Cache para lista de jogadores por aba

// ─── Debounce timer ─────────────────────────────────────────────
let debounceTimer = null;
let suggestionsDebounceTimer = null;

// ─── Elementos do DOM ───────────────────────────────────────────
const elInputPlayer      = document.getElementById('inputPlayer');
const elSplitLeftTitle   = document.getElementById('split-left-title');
const elSplitRightTitle  = document.getElementById('split-right-title');
const elSplitLeftTag     = document.getElementById('split-left-tag');
const elSplitRightTag    = document.getElementById('split-right-tag');
const elTableSplitLeft   = document.getElementById('table-split-left');
const elTableSplitRight  = document.getElementById('table-split-right');
const elLoadingOverlay   = document.getElementById('loading-overlay');
const elDiffStatus       = document.getElementById('diff-status');
const elSuggestionsPopup = document.getElementById('suggestions-popup');
const elSuggestionsList  = document.getElementById('suggestions-list');

// ════════════════════════════════════════════════════════════════
// ALGORITMO DE SIMILARIDADE (Levenshtein Distance)
// ════════════════════════════════════════════════════════════════
/**
 * Calcula a distância de Levenshtein entre duas strings.
 * Quanto menor o valor, mais similares as strings.
 */
function levenshteinDistance(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(0));

  for (let i = 0; i <= len1; i++) matrix[0][i] = i;
  for (let j = 0; j <= len2; j++) matrix[j][0] = j;

  for (let j = 1; j <= len2; j++) {
    for (let i = 1; i <= len1; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }

  return matrix[len2][len1];
}

/**
 * Calcula um score de similaridade (0 a 1).
 * 1 = idêntico, 0 = completamente diferente.
 */
function similarityScore(str1, str2) {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  
  // Se um contém o outro, score alto
  if (s1.includes(s2) || s2.includes(s1)) {
    return 0.9;
  }
  
  const maxLen = Math.max(s1.length, s2.length);
  const distance = levenshteinDistance(s1, s2);
  return 1 - (distance / maxLen);
}

// ════════════════════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL: busca todos os jogadores de uma aba
// ════════════════════════════════════════════════════════════════
/**
 * @param {string} sheetName   – Nome da aba/temporada (ex: "2024 FFWS BR SPLIT 1")
 * @returns {Promise<Array>}   Array com objetos {jogador, equipe}
 */
async function fetchAllPlayersFromSheet(sheetName) {
  if (!sheetName) return [];

  const cacheKey = `ALL_${sheetName.toUpperCase()}`;

  // ── Cache hit ──
  if (playersCache[cacheKey] !== undefined) {
    console.log(`[Cache] hit → ${cacheKey}`);
    return playersCache[cacheKey];
  }

  // ── Resolve o gid da aba ──
  const gid = resolveSheetGid(sheetName);

  // ── Monta a query SQL para buscar TODOS os dados ──
  const query     = encodeURIComponent(`SELECT A, B`);
  const url       = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`
                  + `?tqx=out:json&gid=${gid}&tq=${query}`;

  console.log(`[Fetch All] ${cacheKey} →`, url);

  try {
    const resp = await fetch(url, { cache: 'default' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const text = await resp.text();
    const json = JSON.parse(text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, ''));
    const rows = json?.table?.rows ?? [];

    const players = rows.map(row => {
      const cells = row.c ?? [];
      return {
        jogador: cells[0]?.v ?? null,
        equipe:  cells[1]?.v ?? null,
      };
    }).filter(p => p.jogador); // Remove linhas vazias

    playersCache[cacheKey] = players;
    return players;

  } catch (err) {
    console.error(`[Fetch All ERROR] ${cacheKey}:`, err);
    playersCache[cacheKey] = [];
    return [];
  }
}

// ════════════════════════════════════════════════════════════════
// FUNÇÃO: busca sugestões baseadas em similaridade
// ════════════════════════════════════════════════════════════════
/**
 * @param {string} searchTerm   – Termo digitado pelo usuário
 * @param {string} sheetName    – Nome da aba onde buscar
 * @param {number} maxResults   – Número máximo de sugestões (padrão: 5)
 * @returns {Promise<Array>}    Array com sugestões ordenadas por score
 */
async function fetchSuggestions(searchTerm, sheetName, maxResults = 5) {
  if (!searchTerm || searchTerm.length < 2) return [];

  const players = await fetchAllPlayersFromSheet(sheetName);
  
  // Calcula score para cada jogador
  const scored = players.map(p => ({
    ...p,
    score: similarityScore(searchTerm, p.jogador),
  }));

  // Filtra apenas com score > 0.3 e ordena por score descendente
  return scored
    .filter(p => p.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// ════════════════════════════════════════════════════════════════
// RENDERIZAÇÃO: popup de sugestões
// ════════════════════════════════════════════════════════════════
async function renderSuggestions(searchTerm, sheetName) {
  if (!searchTerm || searchTerm.length < 2) {
    elSuggestionsPopup.classList.add('hidden');
    return;
  }

  const suggestions = await fetchSuggestions(searchTerm, sheetName, 8);

  if (suggestions.length === 0) {
    elSuggestionsPopup.classList.add('hidden');
    return;
  }

  elSuggestionsList.innerHTML = suggestions.map((sug, idx) => `
    <li class="suggestion-item" data-player="${sug.jogador}" onclick="selectSuggestion('${sug.jogador}')">
      <span class="suggestion-player-name">${sug.jogador}</span>
      <span class="suggestion-team">${sug.equipe || '—'}</span>
    </li>
  `).join('');

  elSuggestionsPopup.classList.remove('hidden');
}

/**
 * Seleciona uma sugestão do popup
 */
function selectSuggestion(playerName) {
  elInputPlayer.value = playerName;
  elSuggestionsPopup.classList.add('hidden');
  syncName();
}

// ════════════════════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL: busca dados do Google Sheets
// ════════════════════════════════════════════════════════════════
/**
 * @param {string} playerName  – Nick do jogador (coluna A)
 * @param {string} sheetName   – Nome da aba/temporada (ex: "2024 FFWS BR SPLIT 1")
 * @returns {Promise<Object|null>}  Objeto com os dados do jogador ou null
 */
async function fetchGoogleSheetData(playerName, sheetName) {
  if (!playerName || !sheetName) return null;

  const cacheKey = `${playerName.toUpperCase()}_${sheetName.toUpperCase()}`;

  // ── Cache hit ──
  if (dataCache[cacheKey] !== undefined) {
    console.log(`[Cache] hit → ${cacheKey}`);
    return dataCache[cacheKey];
  }

  // ── Resolve o gid da aba ──
  const gid = resolveSheetGid(sheetName);

  // ── Monta a query SQL para a Google Visualization API ──
  // Filtra pela coluna A (Jogador) com correspondência exata (case-sensitive na API)
  const query     = encodeURIComponent(`SELECT * WHERE A = '${playerName}'`);
  const url       = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`
                  + `?tqx=out:json&gid=${gid}&tq=${query}`;

  console.log(`[Fetch] ${cacheKey} →`, url);

  try {
    const resp = await fetch(url, { cache: 'default' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const text = await resp.text();

    // A resposta é JSONP: google.visualization.Query.setResponse({...})
    const json = JSON.parse(text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, ''));
    const rows = json?.table?.rows ?? [];

    if (rows.length === 0) {
      dataCache[cacheKey] = null;
      return null;
    }

    // ── Extrai valores da primeira linha encontrada ──
    const cells = rows[0].c ?? [];
    const get   = (i) => cells[i]?.v ?? null;

    const result = {
      jogador:        get(0),   // A – Jogador
      equipe:         get(1),   // B – Equipe
      quedas:         get(2),   // C – Quedas
      abates:         get(3),   // D – Abates
      capas:          get(4),   // E – Capas
      derrubados:     get(5),   // F – Derrubados
      gelos:          get(6),   // G – Gelos
      gelosDestru:    get(7),   // H – Gelos Destruídos
      reviveu:        get(8),   // I – Reviveu
      aliadosRev:     get(9),   // J – Aliados Revividos
    };

    // ── Métrica calculada: média de abates por queda ──
    result.mediaAbatesPorQueda = result.quedas
      ? parseFloat((result.abates / result.quedas).toFixed(2))
      : 0;

    dataCache[cacheKey] = result;
    return result;

  } catch (err) {
    console.error(`[Fetch ERROR] ${cacheKey}:`, err);
    showToast(`Erro ao buscar "${playerName}" no split "${sheetName}": ${err.message}`);
    dataCache[cacheKey] = null;
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// GATILHO PRINCIPAL: chamado a cada oninput
// ════════════════════════════════════════════════════════════════
function syncName() {
  // ── Atualiza tags/headers em tempo real (sem esperar fetch) ──
  const splitLeft  = elSplitLeftTitle.textContent.trim();
  const splitRight = elSplitRightTitle.textContent.trim();

  elSplitLeftTag.textContent   = splitLeft  || 'ANTES';
  elSplitRightTag.textContent  = splitRight || 'AGORA';
  elTableSplitLeft.textContent = splitLeft  || 'SPLIT 1';
  elTableSplitRight.textContent= splitRight || 'SPLIT 2';

  // ── Atualiza popup de sugestões com debounce ──
  const player = elInputPlayer.value.trim();
  clearTimeout(suggestionsDebounceTimer);
  suggestionsDebounceTimer = setTimeout(() => {
    if (player.length >= 2) {
      renderSuggestions(player, splitLeft);
    } else {
      elSuggestionsPopup.classList.add('hidden');
    }
  }, 200);

  // ── Debounce: espera 500ms após o usuário parar de digitar ──
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (player.length < 2) {
      resetDashboard();
      return;
    }
    loadPlayerData(player, splitLeft, splitRight);
  }, 500);
}

// ════════════════════════════════════════════════════════════════
// CARREGA OS DADOS DAS DUAS COLUNAS EM PARALELO
// ════════════════════════════════════════════════════════════════
async function loadPlayerData(player, splitLeft, splitRight) {
  showLoading(true);
  elDiffStatus.textContent = 'Buscando…';

  try {
    // ── Busca paralela (Promise.all) ──
    const [dataLeft, dataRight] = await Promise.all([
      fetchGoogleSheetData(player, splitLeft),
      fetchGoogleSheetData(player, splitRight),
    ]);

    // ── Renderiza cada lado ──
    renderPanel('left',  dataLeft,  player);
    renderPanel('right', dataRight, player);

    // ── Renderiza o diff central e a tabela comparativa ──
    if (dataLeft && dataRight) {
      renderDiff(dataLeft, dataRight);
      renderCompareTable(dataLeft, dataRight);
      elDiffStatus.textContent = '✅ Comparação atualizada';
    } else if (!dataLeft && !dataRight) {
      elDiffStatus.textContent = '❌ Jogador não encontrado em nenhum Split';
      clearDiff();
      clearCompareTable();
    } else {
      elDiffStatus.textContent = '⚠️ Jogador encontrado em apenas 1 Split';
      clearDiff();
      clearCompareTable();
    }

  } finally {
    showLoading(false);
  }
}

// ════════════════════════════════════════════════════════════════
// RENDERIZAÇÃO: painel esquerdo ou direito
// ════════════════════════════════════════════════════════════════
function renderPanel(side, data, playerName) {
  const s = side === 'left' ? 'l' : 'r';

  const name    = document.getElementById(`name-${side}`);
  const team    = document.getElementById(`team-${side}`);
  const avatar  = document.getElementById(`avatar-${side}`);

  if (!data) {
    name.textContent  = playerName;
    team.textContent  = 'Não encontrado neste Split';
    avatar.src        = `https://ui-avatars.com/api/?name=${encodeURIComponent(playerName)}&background=2a0a0a&color=ff4d4d&size=128`;
    setStatEmpty(s);
    return;
  }

  // Dados do jogador
  name.textContent  = data.jogador   ?? playerName;
  team.textContent  = data.equipe    ?? '—';
  avatar.src        = `https://ui-avatars.com/api/?name=${encodeURIComponent(data.jogador ?? playerName)}&background=0d1117&color=fff&size=128`;

  // Stats
  setText(`${s}-quedas`,     fmt(data.quedas));
  setText(`${s}-abates`,     fmt(data.abates));
  setText(`${s}-capas`,      fmt(data.capas));
  setText(`${s}-derrubados`, fmt(data.derrubados));
  setText(`${s}-gelos`,      fmt(data.gelos));
  setText(`${s}-gelos-dest`, fmt(data.gelosDestru));
  setText(`${s}-reviveu`,    fmt(data.reviveu));
  setText(`${s}-aliados`,    fmt(data.aliadosRev));
  setText(`${s}-contrib`,    `${data.mediaAbatesPorQueda.toFixed(1)} ab/queda`);
}

function setStatEmpty(prefix) {
  ['quedas','abates','capas','derrubados','gelos','gelos-dest','reviveu','aliados','contrib']
    .forEach(id => setText(`${prefix}-${id}`, '—'));
}

// ════════════════════════════════════════════════════════════════
// RENDERIZAÇÃO: painel central de diferença
// ════════════════════════════════════════════════════════════════
function renderDiff(before, after) {
  const diffs = [
    { id: 'diff-abates',    val: after.abates    - before.abates    },
    { id: 'diff-derrubados',val: after.derrubados- before.derrubados },
    { id: 'diff-capas',     val: after.capas     - before.capas     },
    { id: 'diff-gelos',     val: after.gelos     - before.gelos     },
    { id: 'diff-contrib',   val: parseFloat((after.mediaAbatesPorQueda - before.mediaAbatesPorQueda).toFixed(2)) },
  ];

  diffs.forEach(({ id, val }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const isFloat = id === 'diff-contrib';
    const display = isFloat
      ? (val > 0 ? `+${val.toFixed(2)}` : val.toFixed(2))
      : (val > 0 ? `+${val}` : `${val}`);

    el.textContent = display;
    el.className   = 'diff-value ' + (val > 0 ? 'positive' : val < 0 ? 'negative' : 'zero');
  });
}

function clearDiff() {
  ['diff-abates','diff-derrubados','diff-capas','diff-gelos','diff-contrib'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = '—'; el.className = 'diff-value'; }
  });
}

// ════════════════════════════════════════════════════════════════
// RENDERIZAÇÃO: tabela comparativa
// ════════════════════════════════════════════════════════════════
function renderCompareTable(before, after) {
  const metrics = [
    { label: 'Quedas',            key: 'quedas'           },
    { label: 'Abates',            key: 'abates'           },
    { label: 'Capas',             key: 'capas'            },
    { label: 'Derrubados',        key: 'derrubados'       },
    { label: 'Gelos',             key: 'gelos'            },
    { label: 'Gelos Destruídos',  key: 'gelosDestru'      },
    { label: 'Reviveu',           key: 'reviveu'          },
    { label: 'Aliados Revividos', key: 'aliadosRev'       },
    { label: 'Média Ab./Queda',   key: 'mediaAbatesPorQueda', isFloat: true },
  ];

  const tbody = document.getElementById('compare-tbody');
  tbody.innerHTML = metrics.map(({ label, key, isFloat }) => {
    const vBefore = before[key] ?? 0;
    const vAfter  = after[key]  ?? 0;
    const diff    = vAfter - vBefore;
    const sign    = diff > 0 ? '+' : '';
    const cls     = diff > 0 ? 'td-positive' : diff < 0 ? 'td-negative' : 'td-zero';
    const fmtVal  = isFloat
      ? (v) => Number(v).toFixed(2)
      : (v) => fmt(v);
    const diffStr = isFloat
      ? `${sign}${diff.toFixed(2)}`
      : `${sign}${diff}`;

    return `<tr>
      <td>${label}</td>
      <td>${fmtVal(vBefore)}</td>
      <td class="${cls}">${diffStr}</td>
      <td>${fmtVal(vAfter)}</td>
    </tr>`;
  }).join('');
}

function clearCompareTable() {
  document.getElementById('compare-tbody').innerHTML =
    '<tr><td colspan="4" class="table-placeholder">Nenhum dado para comparar.</td></tr>';
}

// ════════════════════════════════════════════════════════════════
// UTILITÁRIOS
// ════════════════════════════════════════════════════════════════

/** Resolve o GID numérico a partir do nome da aba.
 *  Tenta correspondência exata, depois case-insensitive.
 *  Se não encontrar, usa '0' (primeira aba).
 */
function resolveSheetGid(sheetName) {
  if (!sheetName) return '0';

  // Exato
  if (SHEET_GID_MAP[sheetName] !== undefined) return SHEET_GID_MAP[sheetName];

  // Case-insensitive
  const lower = sheetName.toLowerCase();
  for (const [k, v] of Object.entries(SHEET_GID_MAP)) {
    if (k.toLowerCase() === lower) return v;
  }

  // Fallback: usa '0'
  console.warn(`[resolveSheetGid] Aba "${sheetName}" não encontrada no mapa. Usando gid=0.`);
  return '0';
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('pt-BR');
}

function showLoading(show) {
  elLoadingOverlay.classList.toggle('hidden', !show);
}

function showToast(msg) {
  // Remove toasts anteriores
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function resetDashboard() {
  ['left','right'].forEach(side => {
    const s = side === 'left' ? 'l' : 'r';
    document.getElementById(`name-${side}`).textContent = '—';
    document.getElementById(`team-${side}`).textContent = 'Equipe —';
    document.getElementById(`avatar-${side}`).src =
      'https://ui-avatars.com/api/?name=?&background=1a1a2e&color=fff&size=128';
    setStatEmpty(s);
  });
  clearDiff();
  clearCompareTable();
  elDiffStatus.textContent = 'Busque um jogador';
}

// ════════════════════════════════════════════════════════════════
// FECHAR POPUP AO CLICAR FORA
// ════════════════════════════════════════════════════════════════
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrapper')) {
    elSuggestionsPopup.classList.add('hidden');
  }
});
