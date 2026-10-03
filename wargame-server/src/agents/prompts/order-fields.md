CAMPI DI OGNI ORDINE (usa esattamente questi, tutti obbligatori salvo dove indicato; "id" è una stringa qualsiasi)
military:
- MOVE: {"id","kind":"MOVE","unitIds":[...],"to":"ZONA","speed":"slow"|"cruise"|"flank"}
- PATROL, PRESENCE, SHOW_OF_FORCE, BLOCKADE, EXCLUSION_ZONE: {"id","kind","unitIds":[...],"zoneId":"ZONA","roe":ROE}
- ESCORT: {"id","kind":"ESCORT","unitIds":[...],"protect":"id da proteggere","roe":ROE}
- STRIKE: {"id","kind":"STRIKE","unitIds":[...],"targetRef":"contatto o infrastruttura","munitions":{"nome munizione":numero},"roe":ROE}
- ISR: {"id","kind":"ISR","assetIds":["id preso SOLO da isrAssets nelle AZIONI LECITE"],"zoneId":"ZONA"} (senza unitIds). Gli asset ISR NON sono unità: navi, aerei e droni delle tue unità si usano con PATROL/PRESENCE. Se ISR non è in orderKinds, non usarlo.
- SOF_OP: {"id","kind":"SOF_OP","unitIds":[...],"objective":"...","zoneId":"ZONA","deniability":"overt"|"covert"}
- CYBER_OP: {"id","kind":"CYBER_OP","target":"FAZIONE","targetRef":"...","effect":"espionage"|"disruption"|"defense_hardening"} (senza unitIds)
- AIR_DEFENSE: {"id","kind":"AIR_DEFENSE","unitIds":[...],"zoneId":"ZONA","alert":"low"|"high"}
- REPAIR, RETURN_TO_BASE, STAND_DOWN: {"id","kind","unitIds":[...]}
- EVACUATION: {"id","kind":"EVACUATION","unitIds":[...],"zoneId":"ZONA"}
ROE = "WEAPONS_HOLD"|"WEAPONS_TIGHT"|"WEAPONS_FREE"
diplomacy:
- DEMARCHE, THREAT, REASSURANCE: {"id","kind","target":"FAZIONE","message":"...","visibility":"public" oppure ["FAZIONE",...]}
- PROPOSE_AGREEMENT: {"id","kind":"PROPOSE_AGREEMENT","target":["FAZIONE",...],"agreement":{"type":"defense"|"energy"|"basing"|"migration"|"ceasefire"|"arms_sale"|"intel_sharing"|"secret"|"non_aggression"|"guarantee"|"military_access"|"defense_cooperation"|"trade","parties":["FAZIONE",...],"terms":"...","endTurn":numero|null,"visibility":"public" oppure ["FAZIONE",...]}}
- RESPOND_AGREEMENT: {"id","kind":"RESPOND_AGREEMENT","agreementId":"...","response":"accept"|"reject"|"counter","counterTerms":"..." (facoltativo)}
- SANCTION, LIFT_SANCTION: {"id","kind","target":"FAZIONE","scope":"..."}
- BACKCHANNEL: {"id","kind":"BACKCHANNEL","target":"FAZIONE","message":"..."}
- RESOLUTION: {"id","kind":"RESOLUTION","forum":"UNSC"|"UNGA"|"EU_COUNCIL"|"NATO"|"ARAB_LEAGUE"|"AU","subject":"...","topic":"aggression"|"sanctions"|"humanitarian"|"maritime"|"nonproliferation"|"other","target":"FAZIONE" (facoltativo)}
- IMPROVE_RELATIONS, STOP_IMPROVE, RECALL_AMBASSADOR, EXPEL_DIPLOMATS, BREAK_RELATIONS, RESTORE_RELATIONS, ARMS_EMBARGO, LIFT_ARMS_EMBARGO: {"id","kind","target":"FAZIONE"}
- ULTIMATUM: {"id","kind":"ULTIMATUM","target":"FAZIONE","demand":"...","deadlineTurns":1-4}
- MEDIATE: {"id","kind":"MEDIATE","crisisId":"...","parties":["FAZIONE","FAZIONE"]}
- ENERGY_DEAL: {"id","kind":"ENERGY_DEAL","target":"FAZIONE","infrastructureId":"...","terms":"..."}
- AID: {"id","kind":"AID","target":"FAZIONE","amount":milioni_di_euro,"type":"economic"|"military"}
"target" è UNA sola fazione (stringa), tranne in PROPOSE_AGREEMENT dove è un elenco.
procurement: {"id","itemId":"articolo del catalogo","qty":intero>=1,"destinationBaseId":"tua base"}
statements: {"id","audience":"a chi è rivolta","text":"...","tone":"conciliatory"|"firm"|"threatening"}
