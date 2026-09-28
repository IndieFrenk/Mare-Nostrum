# CLAUDE.md

## Wargame (Mare Nostrum)
Spec: [docs/wargame/SPEC.md](docs/wargame/SPEC.md) · Stato: [docs/wargame/PROGRESS.md](docs/wargame/PROGRESS.md) · Recon: [docs/wargame/RECON.md](docs/wargame/RECON.md)

Comandi:
- `npm --prefix wargame-server test` · `npm --prefix wargame-server run typecheck`
- `npm run wargame:server` · `npm run dev:wargame` · `npm run wargame:all` · `npm run build:wargame`
- `npm run wargame:llm-check` (OmniRoute, config in `wargame-server/.env`) · `npm --prefix wargame-server run geo:build` (coste/zone)
- `npm --prefix wargame-server run sim -- --turns 5 --mock` · `... sim -- --replay <id>`

Regole d'oro:
1. Il motore deterministico è l'unica fonte di verità; gli LLM propongono `FactionOrders`, il motore valida ed esegue.
2. Fog of war: agenti e UI vedono solo `FactionKnowledge`; vista god solo con `debugGodView` o campagna finita.
3. Tutto è registrato (decisioni, tiri, chiamate LLM) nel DB JSON.
4. RNG con seed; il replay rilegge `decisions/` senza chiamare LLM.
5. Stesso schema ordini per umano e IA.
6. I narratori non inventano numeri (validatore sui fatti).
