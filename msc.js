const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const semAcento = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const MESES = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const TV_ORDEM = ["beginning_balance", "period_change", "ending_balance"];

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const int = new Intl.NumberFormat("pt-BR");
function compacto(v) {
  const a = Math.abs(v);
  const f = (x, d) => x.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
  if (a >= 1e9) return `R$ ${f(a / 1e9, 2)} bi`;
  if (a >= 1e6) return `R$ ${f(a / 1e6, 1)} mi`;
  if (a >= 1e3) return `R$ ${f(a / 1e3, 1)} mil`;
  return `R$ ${f(a, 2)}`;
}
function saldo(d, c, formato = compacto) {
  const s = (d || 0) - (c || 0);
  if (Math.abs(s) < 0.005) return `${formato(0)}`;
  return `${formato(s)}<span class="nat">${s > 0 ? "D" : "C"}</span>`;
}
function fmtConta(p) {
  const c = p.padEnd(9, "0");
  return `${c[0]}.${c[1]}.${c[2]}.${c[3]}.${c[4]}.${c.slice(5, 7)}.${c.slice(7, 9)}`;
}
function codNivel(p, cortes) {
  // mostra o código só até o nível do nó (ex.: 6.2.2.1.3)
  const partes = [];
  let ini = 0;
  for (const fim of cortes) {
    if (fim > p.length) break;
    partes.push(p.slice(ini, fim));
    ini = fim;
  }
  return partes.join(".");
}

async function getJSON(url) {
  const r = await fetch(url);
  const b = await r.json();
  if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
  return b;
}

// ---------------------------------------------------------------- acesso aos dados
// Local: rotas do servidor Flask. Publicado (estático): window.MSC_DADOS, com os registros em formato
// colunar e os cálculos de contas e detalhe feitos no navegador, com a mesma lógica do servidor.

const ESTATICO = window.MSC_DADOS || null;

function compEstatica() {
  return ESTATICO.competencias[Number($("competencia").value) || 0];
}

function registrosEstaticos(comp) {
  if (comp._linhas) return comp._linhas;
  const r = comp.registros;
  const campos = Object.keys(r.colunas);
  const linhas = new Array(r.n);
  for (let i = 0; i < r.n; i++) {
    const o = {};
    for (const c of campos) {
      const col = r.colunas[c];
      o[c] = col.dic ? (col.idx[i] < 0 ? null : col.dic[col.idx[i]]) : col.v[i];
    }
    linhas[i] = o;
  }
  comp._linhas = linhas;
  return linhas;
}

async function apiCompetencias() {
  return ESTATICO ? ESTATICO.competencias.map((c) => c.meta) : getJSON("/api/msc/competencias");
}

async function apiResumo() {
  return ESTATICO ? compEstatica().resumo : getJSON(`/api/msc/resumo?${qs()}`);
}

async function apiContas(tv) {
  if (!ESTATICO) return getJSON(`/api/msc/contas?${qs()}&tv=${tv}`);
  const m = new Map();
  for (const l of registrosEstaticos(compEstatica())) {
    if (l.tipo_valor !== tv) continue;
    let a = m.get(l.conta_contabil);
    if (!a) m.set(l.conta_contabil, (a = { conta: l.conta_contabil, registros: 0, d: 0, c: 0 }));
    a.registros++;
    if (l.natureza_conta === "D") a.d += l.valor; else a.c += l.valor;
  }
  return [...m.values()].sort((x, y) => (x.conta < y.conta ? -1 : 1));
}

async function apiDetalhe(tv, prefixo) {
  if (!ESTATICO) return getJSON(`/api/msc/detalhe?${qs()}&tv=${tv}&prefixo=${prefixo}`);
  const comp = compEstatica();
  const meta = ESTATICO.meta;
  const linhas = registrosEstaticos(comp).filter((l) => l.tipo_valor === tv && l.conta_contabil.startsWith(prefixo));
  let d = 0, c = 0;
  const contas = new Set();
  linhas.forEach((l) => { contas.add(l.conta_contabil); if (l.natureza_conta === "D") d += l.valor; else c += l.valor; });
  const dimensoes = [];
  for (const campo of meta.dimensoes) {
    const g = new Map();
    for (const l of linhas) {
      const v = l[campo];
      if (v == null || v === "") continue;
      let a = g.get(v);
      if (!a) g.set(v, (a = { valor: v, rotulo: (comp.rotulos[campo] || {})[v] || v, registros: 0, d: 0, c: 0 }));
      a.registros++;
      if (l.natureza_conta === "D") a.d += l.valor; else a.c += l.valor;
    }
    if (!g.size) continue;
    const itens = [...g.values()].sort((x, y) => Math.abs(y.d - y.c) - Math.abs(x.d - x.c));
    dimensoes.push({ campo, nome: meta.nomes[campo], distintos: itens.length, itens: itens.slice(0, 10) });
  }
  const cortes = estado.resumo.cortes;
  const nivelIdx = Math.max(0, cortes.findIndex((x) => x >= prefixo.length));
  return {
    prefixo, codigo: fmtConta(prefixo), nivel: estado.resumo.niveis[nivelIdx], nome: estado.resumo.pcasp[prefixo] || null,
    registros: linhas.length, contas: contas.size, d, c, dimensoes,
    amostra: [...linhas].sort((x, y) => y.valor - x.valor).slice(0, 25),
    colunas_amostra: meta.colunas_amostra,
  };
}

const estado = { comp: null, tv: "ending_balance", resumo: null, nos: new Map(), abertos: new Set(), sel: null, token: 0 };

function qs() {
  const c = estado.comp;
  return `cod_ibge=${c.cod_ibge}&ano=${c.exercicio}&mes=${c.mes}&tipo_matriz=${c.tipo_matriz}`;
}

// ---------------------------------------------------------------- carga

async function init() {
  const comps = await apiCompetencias();
  if (!comps.length) {
    $("subtitulo").textContent = "Nenhuma MSC extraída ainda. Rode scripts/extract_msc.py.";
    return;
  }
  $("competencia").innerHTML = comps.map((c, i) =>
    `<option value="${i}">${esc(c.ente)} (${esc(c.uf)}) · ${MESES[c.mes]}/${c.exercicio} · ${c.tipo_matriz} · ${int.format(c.registros)} registros</option>`
  ).join("");
  $("competencia").addEventListener("change", () => { estado.comp = comps[Number($("competencia").value)]; carregarTudo(); });
  estado.comp = comps[0];
  await carregarTudo();
}

async function carregarTudo() {
  estado.resumo = await apiResumo();
  const r = estado.resumo;
  $("subtitulo").textContent = `${r.ente} (${r.uf}) · ${MESES[r.mes]} de ${r.exercicio} · matriz ${r.tipo_matriz === "MSCC" ? "mensal agregada (MSCC)" : "de encerramento (MSCE)"}`;
  renderTV();
  renderCampos();
  estado.abertos = new Set();
  estado.sel = null;
  await carregarTV();
}

function renderTV() {
  $("tv").innerHTML = TV_ORDEM.map((k) =>
    `<button type="button" role="radio" data-tv="${k}" aria-checked="${k === estado.tv}">${esc(estado.resumo.tipos_valor[k])}</button>`
  ).join("");
}
$("tv").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-tv]");
  if (!b || b.dataset.tv === estado.tv) return;
  estado.tv = b.dataset.tv;
  renderTV();
  carregarTV();
});
$("tv").addEventListener("keydown", (ev) => {
  if (!["ArrowLeft", "ArrowRight"].includes(ev.key)) return;
  const i = TV_ORDEM.indexOf(estado.tv) + (ev.key === "ArrowRight" ? 1 : -1);
  if (i < 0 || i >= TV_ORDEM.length) return;
  estado.tv = TV_ORDEM[i];
  renderTV();
  $("tv").querySelector(`[data-tv="${estado.tv}"]`).focus();
  carregarTV();
});

async function carregarTV() {
  const meu = ++estado.token;
  const folhas = await apiContas(estado.tv);
  if (meu !== estado.token) return;
  montarArvore(folhas);
  renderStats();
  renderChecks();
  renderClasses();
  renderArvore();
  if (estado.sel) selecionar(estado.sel, false);
  else $("detalhe").innerHTML = `<p class="msc-ajuda">Selecione uma conta na árvore.</p>`;
}

// ---------------------------------------------------------------- resumo

function renderStats() {
  const r = estado.resumo;
  const e = r.equilibrio[estado.tv] || { registros: 0, contas: 0, d: 0 };
  const total = Object.values(r.equilibrio).reduce((s, x) => s + x.registros, 0);
  const tvNome = r.tipos_valor[estado.tv].toLowerCase();
  $("stats").innerHTML = [
    ["Registros", int.format(e.registros), `no ${tvNome} · ${int.format(total)} nos 3 tipos de valor`],
    ["Contas contábeis", int.format(e.contas), "códigos distintos de 9 dígitos"],
    ["Total devedor = credor", compacto(e.d), `soma de cada lado no ${tvNome}`],
    ["Competência", `${String(r.mes).padStart(2, "0")}/${r.exercicio}`, `extraída em ${(r.extraido_em || "").slice(0, 10).split("-").reverse().join("/")}`],
  ].map(([l, v, s]) => `<div class="stat"><div class="stat-label">${l}</div><div class="stat-valor">${v}</div><div class="stat-sub">${s}</div></div>`).join("");
}

function checkSubsistemas() {
  const r = estado.resumo;
  const s = {};
  r.classes.forEach((c) => {
    const t = c.por_tipo[estado.tv];
    s[c.classe] = t ? t.d - t.c : 0;
  });
  const g = (k) => s[k] || 0;
  const linhas = [
    ["Patrimonial (classes 1 a 4)", g(1) + g(2) + g(3) + g(4),
      `Ativo ${saldo(Math.max(g(1), 0), Math.max(-g(1), 0))} = Passivo e PL ${saldo(Math.max(g(2), 0), Math.max(-g(2), 0))} + resultado do período (VPA − VPD) ${saldo(Math.max(g(3) + g(4), 0), Math.max(-(g(3) + g(4)), 0))}`],
    ["Orçamentário (classes 5 e 6)", g(5) + g(6),
      `Aprovação ${saldo(Math.max(g(5), 0), Math.max(-g(5), 0))} = Execução ${saldo(Math.max(g(6), 0), Math.max(-g(6), 0))}`],
    ["Controle (classes 7 e 8)", g(7) + g(8),
      `Controles devedores ${saldo(Math.max(g(7), 0), Math.max(-g(7), 0))} = Controles credores ${saldo(Math.max(g(8), 0), Math.max(-g(8), 0))}`],
  ];
  const ok = linhas.every(([, dif]) => Math.abs(dif) < 0.01);
  return `<div class="check ${ok ? "check-ok" : "check-falha"}"><span class="check-ico" aria-hidden="true">${ok ? "✓" : "×"}</span>
    <div><strong>Cada subsistema fecha sozinho</strong>
    <span class="det">${linhas.map(([n, dif, txt]) => `${n}: ${txt}${Math.abs(dif) < 0.01 ? "" : ` (diferença ${compacto(dif)})`}`).join("<br>")}</span></div></div>`;
}

function renderChecks() {
  const r = estado.resumo;
  const eqOk = TV_ORDEM.every((k) => !r.equilibrio[k] || Math.abs(r.equilibrio[k].diferenca) < 0.01);
  const det = TV_ORDEM.filter((k) => r.equilibrio[k]).map((k) =>
    `${r.tipos_valor[k]}: D ${compacto(r.equilibrio[k].d)} · C ${compacto(r.equilibrio[k].c)}`).join(" | ");
  const cons = r.consistencia;
  const consOk = cons.n_divergentes === 0;
  $("checks").innerHTML = `
    <div class="check ${eqOk ? "check-ok" : "check-falha"}"><span class="check-ico" aria-hidden="true">${eqOk ? "✓" : "×"}</span>
      <div><strong>${eqOk ? "A matriz fecha: total devedor = total credor" : "A matriz não fecha"}</strong>
      <span class="det">Partidas dobradas: em cada tipo de valor, a soma dos valores devedores é igual à dos credores. ${esc(det)}</span></div></div>
    <div class="check ${consOk ? "check-ok" : "check-falha"}"><span class="check-ico" aria-hidden="true">${consOk ? "✓" : "×"}</span>
      <div><strong>Saldo inicial + movimento = saldo final ${consOk ? `em todas as ${int.format(cons.contas)} contas` : `falha em ${int.format(cons.n_divergentes)} de ${int.format(cons.contas)} contas`}</strong>
      <span class="det">Os três tipos de valor se conectam: o saldo final de cada conta é o saldo inicial do mês somado ao movimento.</span></div></div>` +
    checkSubsistemas() + checkNatureza();
}

function checkNatureza() {
  const lista = estado.resumo.natureza_contraria;
  if (!lista) return "";
  if (!lista.length) {
    return `<div class="check check-ok"><span class="check-ico" aria-hidden="true">✓</span>
      <div><strong>Todas as contas terminam o mês com saldo da natureza prevista no PCASP</strong></div></div>`;
  }
  const itens = lista.slice(0, 8).map((x) =>
    `<li><button type="button" class="link-conta" data-conta="${x.conta}"><code>${fmtConta(x.conta)}</code> ${esc(x.nome)}</button>: prevista ${x.esperada.toLowerCase()}, saldo final ${compacto(x.valor)} ${x.atual === "Devedora" ? "D" : "C"}</li>`
  ).join("");
  return `<div class="check check-aviso"><span class="check-ico" aria-hidden="true">!</span>
    <div><strong>${lista.length} ${lista.length === 1 ? "conta termina" : "contas terminam"} o mês com saldo de natureza contrária à prevista no PCASP</strong>
    <span class="det">No saldo final, comparado à natureza de saldo de cada conta no PCASP. Costuma indicar lançamento a revisar (por exemplo, um passivo com saldo devedor). Clique para abrir no explorador.</span>
    <ul class="lista-natureza">${itens}</ul></div></div>`;
}

$("checks").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-conta]");
  if (!b) return;
  if (estado.tv !== "ending_balance") {
    estado.tv = "ending_balance";
    renderTV();
    estado.sel = b.dataset.conta;
    carregarTV().then(() => selecionar(b.dataset.conta));
  } else {
    selecionar(b.dataset.conta);
  }
  $("h-explorador").scrollIntoView({ behavior: "smooth", block: "start" });
});

function renderClasses() {
  const r = estado.resumo;
  $("classes-sub").textContent = `· ${r.tipos_valor[estado.tv].toLowerCase()} · clique para abrir no explorador`;
  $("classes-body").innerHTML = r.classes.map((c) => {
    const t = c.por_tipo[estado.tv] || { registros: 0, contas: 0, d: 0, c: 0 };
    return `<tr class="clicavel" data-prefixo="${c.classe}">
      <td class="txt"><b>${c.classe}</b> · ${esc(c.nome)}</td>
      <td class="txt"><code>${c.endpoint}</code></td>
      <td>${int.format(t.registros)}</td><td>${int.format(t.contas)}</td>
      <td>${brl.format(t.d)}</td><td>${brl.format(t.c)}</td><td>${saldo(t.d, t.c, (x) => brl.format(Math.abs(x)))}</td>
    </tr>`;
  }).join("");
}
$("classes-body").addEventListener("click", (ev) => {
  const tr = ev.target.closest("[data-prefixo]");
  if (!tr) return;
  selecionar(tr.dataset.prefixo);
  $("h-explorador").scrollIntoView({ behavior: "smooth", block: "start" });
});

function renderCampos() {
  const r = estado.resumo;
  const classes = r.classes.map((c) => c.classe);
  $("campos-head").innerHTML = `<th class="txt">Campo</th><th class="txt">O que é</th>` +
    classes.map((k) => `<th title="${esc(r.pcasp[String(k)])}">Classe ${k}</th>`).join("");
  $("campos-body").innerHTML = r.campos.map((f) => `<tr>
      <td class="txt"><b>${esc(f.nome)}</b><br><code>${esc(f.campo)}</code></td>
      <td class="txt">${esc(f.descricao)}</td>
      ${classes.map((k) => {
        const p = f.preenchimento[k];
        return p == null ? `<td class="pct-cel">—</td>` : `<td class="pct-cel${p > 0.999 ? " cheio" : ""}">${(p * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</td>`;
      }).join("")}
    </tr>`).join("");
}

// ---------------------------------------------------------------- árvore

function montarArvore(folhas) {
  const cortes = estado.resumo.cortes;
  const nos = new Map();
  for (const f of folhas) {
    let pai = null;
    for (const fim of cortes) {
      const p = f.conta.slice(0, fim);
      let no = nos.get(p);
      if (!no) {
        no = { p, nivel: cortes.indexOf(fim), d: 0, c: 0, n: 0, filhos: new Set(), pai };
        nos.set(p, no);
      }
      no.d += f.d || 0; no.c += f.c || 0; no.n += f.registros;
      if (pai) nos.get(pai).filhos.add(p);
      pai = p;
    }
  }
  estado.nos = nos;
}

function nomeNo(p) { return estado.resumo.pcasp[p] || null; }

function visiveis() {
  const termo = $("busca").value.trim();
  const raizes = [...estado.nos.values()].filter((n) => n.nivel === 0).map((n) => n.p).sort();
  const out = [];
  if (!termo) {
    const andar = (p) => {
      out.push(p);
      if (estado.abertos.has(p)) [...estado.nos.get(p).filhos].sort().forEach(andar);
    };
    raizes.forEach(andar);
    return { lista: out, busca: false };
  }
  const digitos = termo.replace(/\D/g, "");
  const texto = semAcento(termo);
  const incluir = new Set();
  for (const no of estado.nos.values()) {
    const porCodigo = digitos && /^[\d.\s]+$/.test(termo) && no.p.startsWith(digitos) && no.p.length >= digitos.length;
    const nome = nomeNo(no.p);
    const porNome = !/^[\d.\s]+$/.test(termo) && nome && semAcento(nome).includes(texto);
    if (porCodigo || porNome) {
      let q = no.p;
      while (q) { incluir.add(q); q = estado.nos.get(q).pai; }
      if (porNome) {
        const desc = (p) => estado.nos.get(p).filhos.forEach((f) => { incluir.add(f); desc(f); });
        desc(no.p);
      }
    }
  }
  const andar = (p) => {
    if (!incluir.has(p)) return;
    out.push(p);
    [...estado.nos.get(p).filhos].sort().forEach(andar);
  };
  raizes.forEach(andar);
  return { lista: out, busca: true };
}

function renderArvore() {
  const { lista, busca } = visiveis();
  const cortes = estado.resumo.cortes;
  $("explorador-sub").textContent = `· ${estado.resumo.tipos_valor[estado.tv].toLowerCase()} · ${int.format([...estado.nos.values()].filter((n) => n.p.length === 9).length)} contas`;
  if (!lista.length) {
    $("arvore-body").innerHTML = `<tr><td colspan="3" class="msc-ajuda" style="padding:16px">Nenhuma conta encontrada para “${esc($("busca").value)}”. Tente parte do código (ex.: 6221) ou do nome (ex.: caixa).</td></tr>`;
    return;
  }
  $("arvore-body").innerHTML = lista.map((p) => {
    const no = estado.nos.get(p);
    const temFilhos = no.filhos.size > 0;
    const aberto = busca || estado.abertos.has(p);
    const nome = nomeNo(p);
    const recuo = 6 + no.nivel * 14;
    return `<tr class="nivel-${no.nivel}${estado.sel === p ? " sel" : ""}" data-p="${p}">
      <td style="padding-left:${recuo}px">
        ${temFilhos ? `<button type="button" class="toggle" data-toggle="${p}" aria-label="${aberto ? "Recolher" : "Expandir"} ${codNivel(p, cortes)}" aria-expanded="${aberto}">${aberto ? "▾" : "▸"}</button>` : `<span class="toggle"></span>`}
        <span class="cod">${p.length === 9 ? fmtConta(p) : codNivel(p, cortes)}</span>${nome ? `<span class="nome-conta">${esc(nome)}</span>` : `<span class="sem-nome">${estado.resumo.niveis[no.nivel].toLowerCase()}</span>`}
      </td>
      <td>${saldo(no.d, no.c)}</td>
      <td>${int.format(no.n)}</td>
    </tr>`;
  }).join("");
}

$("arvore-body").addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-toggle]");
  if (t) {
    const p = t.dataset.toggle;
    estado.abertos.has(p) ? estado.abertos.delete(p) : estado.abertos.add(p);
    renderArvore();
    return;
  }
  const tr = ev.target.closest("[data-p]");
  if (tr) selecionar(tr.dataset.p, false);
});
$("busca").addEventListener("input", renderArvore);

// ---------------------------------------------------------------- detalhe

async function selecionar(p, expandir = true) {
  estado.sel = p;
  if (expandir) {
    let q = estado.nos.get(p) ? estado.nos.get(p).pai : null;
    while (q) { estado.abertos.add(q); q = estado.nos.get(q).pai; }
    estado.abertos.add(p);
  }
  renderArvore();
  const meu = ++estado.token;
  $("detalhe").innerHTML = `<p class="msc-ajuda">Carregando...</p>`;
  let d;
  try {
    d = await apiDetalhe(estado.tv, p);
  } catch (e) {
    $("detalhe").innerHTML = `<p class="msc-ajuda">Não foi possível carregar: ${esc(e.message)}</p>`;
    return;
  }
  if (meu !== estado.token) return;
  renderDetalhe(d);
}

function renderDetalhe(d) {
  if (!d.registros) {
    $("detalhe").innerHTML = `<div class="det-cab"><span class="det-cod">${fmtConta(d.prefixo)}</span>
      <span class="det-nome">${esc(d.nome || d.nivel)}</span></div>
      <p class="msc-ajuda">Sem registros desta conta no ${esc(estado.resumo.tipos_valor[estado.tv].toLowerCase())}.</p>`;
    return;
  }
  const dims = d.dimensoes.map((dim) => {
    const max = Math.max(...dim.itens.map((i) => Math.abs(i.d - i.c)), 1e-9);
    return `<div class="dim"><h3>${esc(dim.nome)} <span>· ${int.format(dim.distintos)} ${dim.distintos === 1 ? "valor" : "valores"}${dim.distintos > dim.itens.length ? ` (top ${dim.itens.length})` : ""}</span></h3>
      ${dim.itens.map((i) => `<div class="dim-item" title="${esc(i.rotulo)} · ${int.format(i.registros)} registros">
        <span class="dim-rot">${esc(i.rotulo)}</span><span class="dim-val">${saldo(i.d, i.c)}</span>
        <span class="dim-bar"><span style="width:${(Math.abs(i.d - i.c) / max) * 100}%"></span></span>
      </div>`).join("")}
    </div>`;
  }).join("");

  const cols = d.colunas_amostra.filter((c) => d.amostra.some((r) => r[c] != null && r[c] !== ""));
  const amostra = `<div class="amostra"><h3>Registros reais (os ${d.amostra.length} de maior valor)</h3>
    <div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>${d.amostra.map((r) => `<tr>${cols.map((c) => `<td>${c === "valor" ? brl.format(r[c]) : esc(r[c] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`;

  const info = (estado.resumo.pcasp_info || {})[d.prefixo];
  let blocoPcasp = "";
  if (info) {
    const s = d.d - d.c;
    const atual = Math.abs(s) < 0.005 ? null : s > 0 ? "Devedora" : "Credora";
    const contraria = atual && ["Devedora", "Credora"].includes(info.n) && atual !== info.n;
    const tags = [
      `<span class="pc-tag${contraria ? " pc-alerta" : ""}" title="Natureza de saldo prevista no PCASP">Natureza prevista: ${esc(info.n)}${contraria ? ` · saldo atual ${atual.toLowerCase()}` : ""}</span>`,
      info.sf && info.sf !== "-" ? `<span class="pc-tag" title="Indicador de superávit financeiro">${esc(info.sf)}</span>` : "",
      `<span class="pc-tag">${info.d === "Último" ? "Conta de último nível (recebe lançamentos)" : "Conta sintética (soma os níveis abaixo)"}</span>`,
      info.op && info.op !== "Original" ? `<span class="pc-tag" title="${esc(info.ca || "")}">${esc(info.op)} no PCASP 2027${info.ca && info.ca !== "-" ? `: ${esc(info.ca)}` : ""}</span>` : "",
    ].join("");
    blocoPcasp = `<div class="pcasp-bloco">
      <div class="pc-oficial">${esc(info.to)}</div>
      ${info.f ? `<p class="pc-funcao">${esc(info.f)}</p>` : ""}
      <div class="pc-tags">${tags}</div>
    </div>`;
  }

  $("detalhe").innerHTML = `
    <div class="det-cab">
      <span class="det-cod">${esc(d.codigo)}</span>
      <span class="det-nome">${esc(d.nome || "Sem rótulo de referência")}</span>
      <span class="det-nivel">Nível: ${esc(d.nivel)} · ${esc(estado.resumo.tipos_valor[estado.tv])}</span>
    </div>
    ${blocoPcasp}
    <div class="det-valores">
      <span>Devedor<br><b>${brl.format(d.d)}</b></span>
      <span>Credor<br><b>${brl.format(d.c)}</b></span>
      <span>Saldo<br><b>${saldo(d.d, d.c, (x) => brl.format(Math.abs(x)))}</b></span>
      <span>Registros<br><b>${int.format(d.registros)}</b></span>
      <span>Contas<br><b>${int.format(d.contas)}</b></span>
    </div>
    <p class="msc-ajuda">Como o valor se divide pelas informações complementares (saldo de cada valor, D ou C):</p>
    <div class="dims">${dims || `<p class="msc-ajuda">Esta conta não traz informações complementares.</p>`}</div>
    ${amostra}`;
}

init();
