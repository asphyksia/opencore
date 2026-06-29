# Hermes Agent - Feature Analysis & opencore Applicability

Análisis del código fuente de Hermes Agent para evaluar qué features del "closed learning loop" podemos adaptar a opencore.

---

## 1. Session Search (Cross-Session Recall)

### Cómo lo hace Hermes

**Archivo:** `tools/session_search_tool.py`

**Implementación:**
- Todas las sesiones se guardan en SQLite con **FTS5 full-text index**
- Tool `session_search` con 3 modos:
  1. **DISCOVERY** (`query`) — busca en transcripts con FTS5, retorna snippets + ventana de ±5 mensajes
  2. **SCROLL** (`session_id` + `around_message_id`) — navegar por una sesión específica
  3. **BROWSE** (sin args) — lista sesiones recientes por fecha
- **Zero LLM cost** — todo es query SQL directo
- Deduplicación por "session lineage" (parent chains)

**Schema relevante:**
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  title TEXT,
  created_at TEXT,
  ...
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  role TEXT,
  content TEXT,
  timestamp TEXT,
  ...
);

CREATE VIRTUAL TABLE messages_fts USING fts5(content, tokenize='unicode61');
```

**Aplicabilidad a opencore:** ✅ **ALTA**
- opencode ya guarda sesiones en SQLite (vimos `SessionDB`)
- Solo faltaría:
  1. FTS5 index sobre message content
  2. Tool `session_search` que haga queries
  3. Hook para auto-indexar mensajes al guardarlos

**Esfuerzo:** MEDIO (ya tenemos SQLite + FTS5 en memory/codebase, reusar patterns)

---

## 2. Skill Auto-Creation & Self-Improvement

### Cómo lo hace Hermes

**Archivos clave:**
- `agent/curator.py` — orchestrador background
- `tools/skill_usage.py` — telemetría (uso, views, patches)
- `tools/skill_provenance.py` — distingue skills agent-created vs user-created

**Flujo completo:**

### A. Durante la sesión normal:
1. El agente usa tools y resuelve tareas
2. `skill_usage.py` trackea cada vez que se usa/visualiza/patchea un skill
3. Telemetría se guarda en `~/.hermes/skills/.usage.json`:
   ```json
   {
     "my-skill": {
       "use_count": 5,
       "view_count": 2,
       "patch_count": 1,
       "last_activity_at": "2026-06-29T...",
       "state": "active",
       "created_by": "background_review"
     }
   }
   ```

### B. Background review (Curator):
- **Trigger:** cuando el agente está idle Y pasaron N horas (default 168h = 7 días)
- **Spawn:** fork un **nuevo AIAgent en background** con contexto limitado:
  ```python
  # agent/curator.py L300+
  review_agent = AIAgent(
      client=auxiliary_client,  # modelo auxiliar/cheap
      memory_write_origin="background_review",  # marca provenance
      system_prompt=CURATOR_REVIEW_PROMPT
  )
  ```
- **Prompt del curator** (resumido):
  ```
  You are the skill curator. Review agent-created skills and:
  - PIN high-value skills (used frequently, broadly applicable)
  - ARCHIVE stale skills (inactive >30 days, not pinned, not in cron)
  - CONSOLIDATE redundant skills (merge duplicates)
  - PATCH skills that have minor issues
  
  Available tools: skill_manage (create/edit/archive), skill_list, skill_view
  
  Only touch skills with created_by="background_review".
  Never touch user-created or pinned skills.
  ```

### C. Skill creation:
- Durante una sesión, si el agente detecta un procedimiento repetible, puede crear un skill via `skill_manage create`
- **Provenance tracking:** `skill_provenance.py` usa ContextVar para marcar si el skill se creó en:
  - `"foreground"` — user pidió explícitamente → curator NO lo toca
  - `"background_review"` — curator auto-creó → eligible para auto-curation

### D. State transitions automáticas:
```python
# curator.py aplica estas reglas sin LLM:
- active → stale (si inactive > stale_after_days, default 30)
- stale → archived (si inactive > archive_after_days, default 60)
- archived → active (si se usa de nuevo)
- pinned → bypass all auto-transitions
```

**Aplicabilidad a opencore:** ✅ **ALTA pero COMPLEJA**
- Es la feature más valiosa pero requiere:
  1. Telemetría de skill usage (track cuándo se usan)
  2. Background task runner (curator que corra periódicamente)
  3. Provenance tracking (quién creó el skill)
  4. Tool para que el agente cree skills (`skill_manage`)
  
**Esfuerzo:** ALTO (requiere infra de background tasks + telemetry)

---

## 3. Scheduled Automations (Cron)

### Cómo lo hace Hermes

**Archivos:**
- `cron/scheduler.py` — ejecutor (tick every 60s)
- `cron/jobs.py` — CRUD de jobs
- `tools/cronjob_tool.py` — tool para que el agente schedule

**Implementación:**
- Jobs se guardan en `~/.hermes/cron/jobs.json`:
  ```json
  {
    "daily-backup": {
      "id": "daily-backup",
      "schedule": {"kind": "cron", "expr": "0 2 * * *"},
      "command": "Backup the project to ~/backups/",
      "enabled": true,
      "last_run_at": null
    }
  }
  ```
- **Scheduler corre en el gateway** (daemon 24/7)
- `scheduler.tick()` se llama cada 60s desde un thread:
  ```python
  # gateway/main.py
  def _cron_tick_loop():
      while running:
          time.sleep(60)
          scheduler.tick()
  ```
- Cuando un job es "due", el scheduler **spawns un AIAgent** con el command como prompt:
  ```python
  agent = AIAgent(client=..., system_prompt="You are a cron executor...")
  result = agent.run(job["command"])
  ```

**Trigger types:**
- `"once"` — una sola vez en timestamp específico
- `"interval"` — cada N segundos
- `"cron"` — expresión cron estándar (requiere `croniter`)

**Aplicabilidad a opencore:** ⚠️ **MEDIA (requiere gateway 24/7)**
- opencode no tiene daemon por defecto — corre cuando lo abrís
- El **gateway de opencore ya existe** (`/gateway`) pero no tiene scheduler
- Para implementar:
  1. Agregar scheduler loop al gateway
  2. Tool `schedule_task` para crear jobs
  3. Storage de jobs (JSON o SQLite)

**Esfuerzo:** MEDIO-ALTO (gateway existe, falta scheduler + tool)

---

## 4. Subagent Delegation (Kanban/Dispatcher)

### Cómo lo hace Hermes

**Archivos:**
- `tools/kanban_tools.py` — board CRUD
- `agent/kanban_dispatcher.py` — orchestrator loop
- `plugins/kanban/` — web UI

**Arquitectura:**
- **Kanban board** en SQLite con estados: `todo`, `in_progress`, `done`, `blocked`
- **Dispatcher** loop (cada 60s):
  1. Busca tasks en estado `ready`
  2. Asigna a un "profile" (tipo de agente)
  3. Spawns un AIAgent con el task como prompt
  4. Task pasa a `in_progress` con claim lock
  5. Cuando termina, pasa a `done`
- **Isolation:** cada worker es una sesión separada con su propio context
- **Tools para workers:**
  - `kanban_show` — ver el task actual
  - `kanban_complete` — marcar task como done
  - `kanban_block` — marcar bloqueado + reason
  - `kanban_heartbeat` — evitar timeout (tasks long-running)

**Aplicabilidad a opencore:** ❌ **BAJA (overkill)**
- Es infra para workstreams paralelos complejos (tipo Jira interno)
- opencore ya tiene **child sessions** para reflexión/isolation
- Para delegation simple, child sessions + memory son suficientes
- Kanban completo es excesivo a menos que tengas un equipo de agentes coordinándose

**Esfuerzo:** MUY ALTO (+ poco ROI para un agente personal)

---

## 5. Honcho Dialectic User Modeling

### Qué es

**Honcho** es una librería externa de Plastic Labs para "dialectic user modeling" — construir un perfil del usuario a través de contradicciones/refinamientos iterativos.

**En Hermes:**
- Integración opcional via plugin
- No es core de Hermes, es un add-on

**Aplicabilidad a opencore:** ❌ **BAJA**
- Ya tenemos memory con auto-extraction + conflict resolution
- Honcho es overkill para nuestro caso de uso
- Si queremos algo más sofisticado, antes optimizamos lo que tenemos

---

## Resumen: ¿Qué adaptar a opencore?

| Feature | Prioridad | Esfuerzo | Razón |
|---------|-----------|----------|-------|
| **Session Search** | 🟢 ALTA | Medio | High ROI — "cómo resolví X antes" es muy útil. Infra ya existe (SQLite+FTS5). |
| **Skill Auto-Creation** | 🟢 ALTA | Alto | El loop cerrado de aprendizaje. Complejo pero diferenciador. |
| **Skill Self-Improvement (Curator)** | 🟡 MEDIA | Alto | Interesante pero requiere background runner. Hacer después de auto-creation. |
| **Cron/Scheduler** | 🟡 MEDIA | Medio-Alto | Útil si usas el gateway 24/7. No aplica si solo usas desktop app. |
| **Kanban Delegation** | 🔴 BAJA | Muy Alto | Overkill — child sessions ya cubren isolation básica. |
| **Honcho** | 🔴 BAJA | N/A | Plugin externo, no core. Ya tenemos memory robusta. |

---

## Propuesta de implementación por fases

### **Fase 1: Session Search** (1-2 días)
1. Agregar FTS5 index sobre messages en SessionDB
2. Tool `session_search` con modos DISCOVERY/SCROLL/BROWSE
3. Hook para auto-indexar mensajes al guardarlos
4. Actualizar agent souls para mencionar el tool

**Deliverable:** poder buscar "cuándo hablamos sobre X" en sesiones pasadas

### **Fase 2: Skill Telemetry** (1 día)
1. Archivo `.opencore/skills/.usage.json` para trackear uso
2. Hook en skill execution para incrementar counters
3. Tool `skill_stats` para ver qué skills se usan más

**Deliverable:** visibilidad de qué skills son útiles

### **Fase 3: Skill Auto-Creation** (2-3 días)
1. Tool `skill_create` para que el agente genere SKILL.md
2. Provenance tracking (ContextVar: foreground vs auto-created)
3. Prompt hint en `session.idle`: "si resolviste algo complejo, considera crear un skill"
4. Validación de skills creados (syntax, no prompt injection)

**Deliverable:** agente propone guardar procedimientos como skills reutilizables

### **Fase 4 (Opcional): Curator Background** (3-4 días)
1. Background task runner (cron simple o tick loop en gateway)
2. Curator logic: auto-archive stale skills, consolidate duplicates
3. CLI `opencore curator run` para preview/manual trigger

**Deliverable:** skills se auto-mantienen, no acumulan basura

### **Fase 5 (Opcional): Scheduler** (2-3 días)
1. Tool `schedule_task` para crear cron jobs
2. Scheduler loop en gateway
3. Storage de jobs en SQLite

**Deliverable:** "recuérdame mañana", "daily git status"

---

## Siguiente paso

¿Arrancamos con **Fase 1 (Session Search)**? Es la de mayor ROI/esfuerzo y reutiliza infra que ya tenemos (FTS5, SQLite).

Alternativamente, si preferís ir directo al loop cerrado de aprendizaje, podemos arrancar con **Fase 3 (Skill Auto-Creation)** y hacer telemetry después.

¿Cuál te parece más valiosa?
