# Progetto: i moduli (un nucleo piccolo e parti che si spengono)

*[English](DESIGN-modules.md)*

Stato: **prima versione realizzata** · il sistema dei moduli, quattro moduli (sala giochi, statistiche, bacheca delle
idee, percorsi protetti) e la scheda nella console admin. La [tabella di marcia](#9-tabella-di-marcia) dice cosa si
sposta dopo.

Stazione si adatta alla squadra che la usa: chiedi una modifica al tuo agente e lui la fa. Se la fa modificando il
nucleo, ogni squadra finisce con il suo fork e ogni aggiornamento di Stazione diventa più difficile da prendere. I
moduli risolvono questo: il nucleo resta piccolo e uguale per tutti, e ciò che una squadra aggiunge o toglie vive nelle
sue cartelle.

## 1. Quattro modi di personalizzare, dal più leggero

| Livello | Cosa | Dove | Sopravvive a un aggiornamento |
|---|---|---|---|
| 1. Interruttori e impostazioni | Spegnere un modulo, cambiarne le impostazioni | *Console admin → Moduli* | Sempre |
| 2. Temi | L'aspetto della stazione | Il selettore del tema in alto; un modulo può portare i suoi stili | Sempre |
| 3. Moduli | Funzioni nuove, regole nuove, un sostituto di una parte di serie (spegni quella di serie, aggiungi la tua) | `modules-custom/<id>/` | Sì: gli aggiornamenti non toccano mai quella cartella |
| 4. Fork | Cambiare il funzionamento del nucleo | `lib/`, `public/`, `modules/` | Con lavoro di unione: è l'uscita di emergenza, non la strada normale |

Gli agenti seguono lo stesso ordine: per cambiare la stazione di una squadra usano il livello più leggero che basta, e
toccano il nucleo solo quando un umano lo chiede esplicitamente (vedi i file di protocollo in `docs/`).

## 2. Cosa è nucleo e cosa è modulo

**Nucleo** (sempre acceso, nessun modulo può cambiarlo): account, accesso, passkey e browser; ruoli, permessi, accesso
alle stanze e limiti dei token; agenti, missioni, blocchi e messaggi; approvazioni, azioni drastiche, ricezione, dati
protetti; la console admin, il registro e gli avvisi di sicurezza; l'API, il client degli agenti e il caricatore dei
moduli.

**Moduli di serie** (`modules/`, accesi salvo dove indicato):

| Modulo | Cos'è | Parti |
|---|---|---|
| `lounge` | La sala giochi sotto il ponte principale. Spenta: gli agenti in pausa restano alla scrivania, il ponte inferiore è un pavimento vuoto, la mappa non ha la sala giochi. | browser (scena) |
| `stats` | Grafici e tabelle nella sezione Tecnica. | server (`GET /api/stats`) + browser |
| `ideas` | La bacheca delle idee solo per gli umani, a `/m/ideas` (e al vecchio `/ideas`). | server (`/api/notes`, `/api/idea-categories`) + pagina + link in alto |
| `protected-paths` | Rifiuta missioni e blocchi sui percorsi che gli agenti non devono mai cambiare. **Spento di base**; un esempio di regola di un modulo. | server (regole) + impostazioni |

**I dati restano nel nucleo.** Le tabelle dei moduli di serie fanno parte dello schema del nucleo: spegnere un modulo
non perde né rovina mai i dati, e riaccendendolo si ritrova tutto com'era.

## 3. Com'è fatto un modulo

Una cartella con il nome del modulo (lettere minuscole, cifre e trattini), con un `module.json`:

```json
{
  "id": "standup-reminder",
  "name": "Stand-up reminder",
  "description": "Una frase: il proprietario la legge nella console admin.",
  "version": "1",
  "defaultEnabled": false,
  "server": "server.js",
  "client": "client.js",
  "style": "style.css",
  "page": "page.html",
  "assets": ["page.js"],
  "settings": [{ "key": "hour", "label": "Hour of the reminder", "type": "text", "default": "09:30" }],
  "translations": { "it": { "Stand-up reminder": "Promemoria dello stand-up", "Hour of the reminder": "Ora del promemoria" } }
}
```

| Campo | Significato |
|---|---|
| `server` | Gira sul server: rotte, regole, eventi, tabelle. Esporta `default function setup(station)`. |
| `client` | Gira nella pagina della stazione: esporta `default function mount(station)`. |
| `scene` | Disegna nella scena della stazione. Per ora un solo spazio, la striscia sotto la stanza principale (usata da `lounge`). |
| `style` | Un foglio di stile aggiunto alla pagina della stazione. |
| `page` | Una pagina sua, servita a `/m/<id>`. |
| `assets` | Altri file per il browser (vengono serviti solo i file elencati). |
| `settings` | Si modificano dalla console admin: `text`, `list` (uno per riga) o `bool`. |
| `translations` | I testi che il modulo mostra, per lingua; le traduzioni del nucleo hanno la precedenza. |

Ogni file nominato deve esistere nella cartella, altrimenti il modulo non viene caricato.

## 4. Lato server: cosa può fare un modulo

`setup(station)` riceve:

- **`station.route(metodo, percorso, opzioni, gestore)`**: una rotta dell'API, con le stesse opzioni e gli stessi
  controlli del nucleo (`auth`, `perm`...). I moduli della squadra aggiungono rotte **solo sotto `/api/m/<id>/`**;
  quelli di serie tengono i loro percorsi storici. Nessuno può aggiungere rotte sotto `/api/admin/` o `/api/modules`,
  né sostituire una rotta del nucleo. Le rotte di un modulo spento rispondono 404.
- **`station.guard(azione, fn)`**: una regola che gira prima di un'azione del nucleo. Restituisce un motivo per
  **rifiutare**, oppure niente. Non può mai permettere ciò che il nucleo rifiuta, saltare un'approvazione o cambiare la
  richiesta. Se va in errore, l'azione viene rifiutata (fallisce chiusa).
- **`station.on(evento, fn)`**: gira dopo che l'azione è stata salvata, fuori dalla richiesta; un errore viene scritto
  nel log e ignorato.
- **`station.schema(sql)`**: tabelle di un modulo della squadra, **solo** `create table/index if not exists mod_<id>_...`.

| Regola | Dati ricevuti |
|---|---|
| `mission.create` | `title, detail, project, resources, priority, due, assignee, createdBy` |
| `lock.take` | `agent, project, resources, reason, taskId` |
| `message.send` | `from, to, project, protected, text` (`text` è `null` per i dati protetti: non arrivano mai ai moduli) |

| Evento | Dati ricevuti |
|---|---|
| `mission.created` | `id, title, project, resources, priority, due, assignee, createdBy` |
| `lock.taken` | `agent, project, resources, reason, taskId, expiresAt` |
| `message.sent` | `id, from, to, project, quiet, text` (solo messaggi normali) |

Le regole ricevono `{ q, ctx, payload, settings }`, gli eventi `{ q, payload }` (`q` esegue SQL). Esempio:

```js
export default function setup(station) {
  station.route('GET', '/api/m/standup-reminder/next', { auth: 'human', perm: 'station.view' }, async () => ({ at: '09:30' }));
  station.guard('mission.create', ({ payload }) => (/friday deploy/i.test(payload.title) ? 'Niente deploy il venerdì.' : null));
}
```

## 5. Lato browser

`mount(station)` riceve `station.api`, `el`, `say`, `__` (traduzione), `can`, `locale` e:

- **`station.slot(nome)`**: un contenitore vuoto nella pagina. `header` (accanto alla campanella), `station`,
  `missions`, `journal`, `tech` (uno per sezione, dopo i pannelli del nucleo).
- **`station.on(nome, fn)`**: `room` (la stanza sullo schermo; `''` è tutta la stazione) e `state` (dati freschi della
  stazione).

Gli script importano gli strumenti del nucleo con il percorso assoluto (`import { el } from '/js/common.js'`). I file
vengono serviti a `/m/<id>/<file>`, solo finché il modulo è acceso.

## 6. Regole di sicurezza

- **Un modulo è codice fidato.** Gira sul server come il nucleo, quindi lo installa chi controlla la repository e il
  deploy, mai dal pannello. Accendere un modulo della squadra chiede una conferma.
- **Accendere e spegnere i moduli** richiede il permesso `admin.modules` e la conferma dell'identità (come ogni azione
  delicata della console), e finisce nel registro. Il proprietario lo ha sempre; sulle stazioni create prima dei
  moduli, il proprietario lo assegna agli altri ruoli da *Console admin → Ruoli*.
- **Le regole del nucleo restano accese:** permessi, accesso alle stanze, approvazioni, ricezione e dati protetti non
  sono moduli e non si possono spegnere. Le rotte dei moduli passano per gli stessi controlli di quelle del nucleo
  (accesso, permessi, regole di rete, limiti delle stanze per i percorsi che il nucleo conosce).
- **API stretta:** le regole possono solo rifiutare; gli eventi girano dopo il salvataggio; rotte e tabelle della
  squadra sono confinate ai loro nomi; un modulo rotto viene lasciato fuori (e la console lo segnala) invece di far
  cadere la stazione.

## 7. Deploy

- **Vercel:** `vercel.json` include `modules/` e `modules-custom/` nella funzione (`includeFiles`) e porta `/m/<id>`
  alle pagine dei moduli. Aggiungi o cambi un modulo, poi fai il deploy.
- **Docker:** l'immagine copia entrambe le cartelle.
- **In locale:** `node server.js` le legge all'avvio.

I moduli vengono letti una volta a ogni avvio; accenderli e spegnerli dalla console ha effetto subito.

## 8. Per gli agenti

Per cambiare il funzionamento della stazione per una squadra: scrivi o modifica un modulo in `modules-custom/`,
partendo da [`modules-custom/README.md`](../modules-custom/README.md) o da `modules/protected-paths/`. Non modificare
`lib/`, `public/` o `modules/` a meno che un umano non chieda esplicitamente una modifica al nucleo.

## 9. Tabella di marcia

I prossimi candidati da portare fuori dal nucleo, uno alla volta e ognuno con i suoi test: la pagina progetto e le
tappe, i suoni, le notifiche Telegram, il diario di bordo, le votazioni (toccano molte parti del server: provenienza,
ricezione, riepilogo serale, Telegram), poi i temi come moduli. Nuove regole ed eventi verranno aggiunti quando un
modulo vero ne avrà bisogno, mai per permettere a un modulo di allentare una regola del nucleo.
