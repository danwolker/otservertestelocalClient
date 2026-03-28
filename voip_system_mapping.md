# Arquitetura e Mapeamento do Sistema VoIP

Este documento detalha o funcionamento desacoplado do sistema VoIP, composto por quatro módulos interdependentes: **OTClient**, **Voip-Helper**, **Voip-Server** e **Forgottenserver (TFS)**.

## 1. Visão Geral da Arquitetura
O sistema foi desenhado de forma modular para que o processamento de áudio e a persistência não sobrecarreguem o servidor de jogo (TFS).

![Arquitetura VoIP](file:///C:/Users/DaniMateus/.gemini/antigravity/brain/db2feb30-0d18-4fa1-9cfd-85a94fc6b39f/voip_architecture_diagram_v2_1774469426684.png)

### Os 4 Módulos
| Módulo | Papel Principal | Localização |
| :--- | :--- | :--- |
| **OTClient (OTC)** | Interface de usuário (Lua) e controle de lógica de interface. | Cliente |
| **Voip-Helper** | Ponte local para captura de áudio (PowerShell/Node) e bridge WebSocket. | Cliente (`otclientv8/voip-helper`) |
| **VoIP Server** | **Núcleo Central**. Gerencia conexões WS, persistência (Prisma) e relay de áudio. | Servidor Remoto (`voip-server`) |
| **Forgottenserver (TFS)** | Servidor de Jogo. Notifica o VoIP Server sobre eventos de Party para sincronia. | Servidor Remoto (`forgottenserver`) |

---

## 2. Fluxo de Convite e Persistência
A persistência ocorre no **VoIP Server** assim que o TFS notifica uma mudança na Party.

```mermaid
sequenceDiagram
    autonumber
    participant P1 as Líder (OTC)
    participant TFS as Forgottenserver
    participant VS as VoIP Server (Core)
    participant DB as Banco de Dados (Prisma)
    participant P2 as Convidado (OTC)

    P1->>TFS: Ação de Convite (Party Invite)
    TFS->>TFS: Game::playerInviteToParty (C++)
    TFS->>TFS: Criação do Objeto Party
    
    Note over TFS,VS: Sincronização Desacoplada
    TFS->>VS: HTTP POST /rooms/party-ID/join
    VS->>DB: prisma.voipRoom.upsert (Cria Sala)
    VS->>DB: prisma.voipSession.upsert (Sessão do Líder)
    VS-->>TFS: 200 OK (sessionKey, wsUrl)
    
    TFS->>P1: Extended Opcode 210 (Dados da Sessão)
    
    P2->>TFS: Aceita Convite
    TFS->>TFS: Party::joinParty
    TFS->>VS: HTTP POST /rooms/party-ID/join (Dados P2)
    VS->>DB: prisma.voipSession.upsert (Sessão do P2)
    VS-->>TFS: 200 OK
    
    TFS->>P2: Extended Opcode 210 (Dados da Sessão)
```

---

## 3. Fluxo de Conexão e Áudio
O **VoIP Server** é o responsável final por criar o túnel de áudio e autenticar as sessões.

```mermaid
graph TD
    A[OTC: game_voip.lua] -->|Opcode 210 via TFS| B(Recebe sessionKey)
    B -->|WS Connect: local| C[Voip-Helper: local bridge]
    C -->|WS Redirect: auth| D[VoIP Server: Central Hub]
    D -->|Validação Prisma| E[(SQLite: voipSession)]
    
    E -->|Success| D
    D -->|JSON: welcome| C
    C -->|Status: Online| A
    
    Note over C,D: O Helper captura áudio via PowerShell e envia Opus para o Server
    
    style D fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#fff
    style C fill:#0f172a,stroke:#818cf8,color:#fff
    style E fill:#0f172a,stroke:#10b981,color:#fff
```

---

## 4. Detalhes de Persistência (voip-server/src/roomManager.ts)
Diferente do TFS, o VoIP Server persiste as salas e sessões de forma independente:

- **RoomManager.createOrJoin**: Chamada via REST API pelo TFS. Executa o `upsert` no banco de dados.
- **Prisma Schema**:
    - `VoipRoom`: Identifica a party e configurações globais (Mute).
    - `VoipSession`: Chave temporária associada ao jogador e à sala.
- **Desacoplamento**: Se o VoIP Server reiniciar, o TFS pode restabelecer as salas enviando novos snapshots das parties ativas.

---

> [!TIP]
> **Como salvar este documento:**
> Você pode salvar este conteúdo como arquivo `.md`. Para visualização premium fora do VS Code, recomendo usar o **Typora**, **Obsidian** ou o [Mermaid Live Editor](https://mermaid.live/) para exportar os fluxogramas em PNG/PDF de alta qualidade.
