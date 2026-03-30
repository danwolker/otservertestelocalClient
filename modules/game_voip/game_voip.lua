voipWindow = nil
voipButton = nil
voipUpdateEvent = nil

local OPCODE_VOIP = 200
local OPCODE_SESSION = 210
local OPCODE_SPEAKING = 201

local VOCATION_INFO = {
  [0] = { name = "None", color = "#888888", icon = "-" },
  [1] = { name = "Sorcerer", color = "#8A2BE2", icon = "S" },
  [2] = { name = "Druid", color = "#32CD32", icon = "D" },
  [3] = { name = "Paladin", color = "#FFD700", icon = "P" },
  [4] = { name = "Knight", color = "#C0C0C0", icon = "K" },
  [5] = { name = "Master Sorcerer", color = "#8A2BE2", icon = "S" },
  [6] = { name = "Elder Druid", color = "#32CD32", icon = "D" },
  [7] = { name = "Royal Paladin", color = "#FFD700", icon = "P" },
  [8] = { name = "Elite Knight", color = "#C0C0C0", icon = "K" },
  [9] = { name = "Monk", color = "#C0C0C0", icon = "M" },
  [10] = { name = "Exalted Monk", color = "#C0C0C0", icon = "M" },
}

-- Maps vocation id ranges to mute button ids
local VOCATION_MUTE_ID = {
  [0] = "All",
  [1] = "Sorcerer", [5] = "Sorcerer",
  [2] = "Druid",    [6] = "Druid",
  [3] = "Paladin",  [7] = "Paladin",
  [4] = "Knight",   [8] = "Knight",
  [9] = "Monk",     [10] = "Exalted Monk",
}

-- member data stored by name, populated from server opcode
local partyData = {}  -- {name -> {vocID, isLeader, id, outfit}}
local mutedVocations = {}
local mutedPlayers = {}      -- mute LOCAL: jogadores ignorados por mim nesta sessão
local mutedGlobals = {}      -- IDs de jogadores silenciados GLOBALMENTE (recebido do servidor)
local mutedGlobalVocations = {} -- IDs de vocações silenciadas GLOBALMENTE (recebido do servidor)
local isGlobalMuted = false  -- estado do mute global da sala (enviado pelo líder)
local pttBinding = nil
local pttPressed = false
local checkPttEvent = nil
local lastReportTime = 0

-- Local Helper Connection
local helperWs = nil
local helperRetryEvent = nil
local helperLaunched = false

-- Forward declaration
local function checkPttState() end

local function split(text, sep)
  local res = {}
  for str in string.gmatch(text, "([^"..sep.."]+)") do
    table.insert(res, str)
  end
  return res
end

local function getCreatureByName(name)
  local player = g_game.getLocalPlayer()
  if not player then return nil end
  local spectators = g_map.getSpectators(player:getPosition(), false)
  for _, spec in ipairs(spectators) do
    if spec:getName():lower() == name:lower() then
      return spec
    end
  end
  return nil
end

function init()
  if not json then
    local ok, err = pcall(function() dofile('/modules/corelib/json.lua') end)
    if not ok then print(">> [VoIP] Warning: Failed to load json.lua: " .. tostring(err)) end
  end
  
  voipButton = modules.client_topmenu.addRightGameToggleButton(
    'voipButton', tr('Party VoIP'), '/data/images/topbuttons/audio', toggle
  )
  voipButton:setOn(false)

  voipWindow = g_ui.loadUI('game_voip', modules.game_interface.getRightPanel())
  voipWindow:setup()
  voipWindow:close()

  ProtocolGame.registerExtendedOpcode(OPCODE_VOIP, onVoipUpdate)
  ProtocolGame.registerExtendedOpcode(OPCODE_SESSION, onExtendedVoipSession)
  ProtocolGame.registerOpcode(0xE0, onVoipSession)
  ProtocolGame.registerOpcode(0xE1, onVoipClose)
  connect(g_game, { onGameStart = onGameStart, onGameEnd = clearMembers })
  
  if checkPttEvent then removeEvent(checkPttEvent) end
  checkPttEvent = scheduleEvent(checkPttState, 100)
  
  -- Check for PTT binding every second or on session join
  scheduleEvent(updatePttBinding, 1000)
  
  -- Start heartbeat to local helper
  sendPingToHelper()

  -- Connect to Local VoIP Helper
  connectToHelper()
  
  -- Start speaking animation loop
  cycleSpeakingAnimation()
end

function connectToHelper()
  if helperWs then
    pcall(function() helperWs.close() end)
    helperWs = nil
  end

  print(">> [VoIP] Connecting to local Helper (ws://127.0.0.1:3002/)...")
  local callbacks = {
    onOpen = function()
      print(">> [VoIP] Connected to local Helper.")
      if modules.client_background then
        modules.client_background.updateVoipStatus(true)
      end
      if helperRetryEvent then
        removeEvent(helperRetryEvent)
        helperRetryEvent = nil
      end
    end,
    onMessage = function(data)
      if data.type == 'STATUS_UPDATE' then
        if data.voiceLevel and modules.client_options and modules.client_options.updateVoiceActivity then
          modules.client_options.updateVoiceActivity(data.voiceLevel)
        end
        local localName = g_game.getCharacterName()
        for _, member in ipairs(data.members) do
          local name = member.name
          if name == 'LOCAL_USER' then name = localName end
          
          if partyData[name] then
            partyData[name].latency = member.latency
            partyData[name].status = member.status
            refreshMemberUI(name)
          end
        end
        
      elseif data.type == 'global_mute_changed' then
        isGlobalMuted = data.muted
        local estado = data.muted and 'ATIVADO' or 'DESATIVADO'
        local msg = 'Mute global ' .. estado .. ' pelo líder ' .. tostring(data.byLeader) .. '.'
        if not data.muted or isLocalLeader() then
          modules.game_textmessage.displayStatusMessage(msg)
        end
        local btn = voipWindow:recursiveGetChildById('GlobalAll')
        if btn then btn:setChecked(data.muted) end
        for name, _ in pairs(partyData) do refreshMemberUI(name) end

      elseif data.type == 'player_mute_changed' then
        local id = tonumber(data.targetPlayerId)
        if data.isGlobal then
          mutedGlobals[id] = data.muted
        end
        for name, d in pairs(partyData) do
          if d.id == id then refreshMemberUI(name) end
        end

      elseif data.type == 'vocation_mute_changed' then
        local vocId = tonumber(data.vocId)
        local vocMuteId = VOCATION_MUTE_ID[vocId] or ""
        if data.isGlobal then
          mutedGlobalVocations[vocId] = data.muted
          local btn = voipWindow:recursiveGetChildById('G-' .. vocMuteId)
          if btn then btn:setChecked(data.muted) end
        else
          mutedVocations[vocMuteId] = data.muted
          local btn = voipWindow:recursiveGetChildById(vocMuteId)
          if btn then btn:setChecked(data.muted) end
          
          -- Sincronizar o botão "MUTE ALL" local
          local vocationPanel = voipWindow:recursiveGetChildById('vocationPanel')
          local allChecked = true
          if vocationPanel then 
            for _, child in ipairs(vocationPanel:getChildren()) do 
              if not child:isChecked() then allChecked = false break end 
            end 
          end
          local allBtn = voipWindow:recursiveGetChildById('All')
          if allBtn then allBtn:setChecked(allChecked) end
          mutedVocations["All"] = allChecked
        end
        for name, d in pairs(partyData) do
          if d.vocID == vocId then refreshMemberUI(name) end
        end

      elseif data.type == 'mute_member_ack' then
        print('[VoIP] Mute local confirmado pelo servidor: ID ' .. tostring(data.targetPlayerId) .. ' -> ' .. tostring(data.muted))

      elseif data.type == 'error' then
        modules.game_textmessage.displayFailureMessage('[VoIP] ' .. tostring(data.message))

      elseif data.type == 'DEVICE_LIST' then
        if modules.client_options and modules.client_options.updateDeviceList then
          modules.client_options.updateDeviceList(data.devices)
        end
      elseif data.type == 'DEVICE_LIST_OUT' then
        if modules.client_options and modules.client_options.updateSpeakerList then
          modules.client_options.updateSpeakerList(data.devices)
        end
      elseif data.type == 'report_response' then
        if data.success then
          displayInfoBox(tr('Report Protocol'), tr('Sua denúncia foi registrada com sucesso sob o Protocolo: #') .. tostring(data.protocol) .. tr('\n\nUse este número ao abrir um ticket no website do jogo.'))
          modules.game_textmessage.displayStatusMessage(tr('Denuncia criada com sucesso! Numero do Protocolo: #') .. tostring(data.protocol))
        else
          modules.game_textmessage.displayFailureMessage(tr('Erro no Report: ') .. tostring(data.error))
        end
      end
    end,
    onClose = function()
      if modules.client_background then
        modules.client_background.updateVoipStatus(false)
      end
      helperWs = nil
      for name, _ in pairs(partyData) do
        if partyData[name] then
           partyData[name].status = 'offline'
           refreshMemberUI(name)
        end
      end
      if not helperRetryEvent then
        helperRetryEvent = scheduleEvent(connectToHelper, 3000)
      end
    end,
    onError = function(err)
      if not helperLaunched then
         helperLaunched = true
         g_platform.openUrl("voip-helper.vbs")
      end
    end
  }
  
  local ok, res = pcall(function() return HTTP.webSocketJSON("ws://127.0.0.1:3002/", callbacks) end)
  if ok then
    helperWs = res
    if helperRetryEvent then removeEvent(helperRetryEvent) helperRetryEvent = nil end
  elseif not helperRetryEvent then
    helperRetryEvent = scheduleEvent(connectToHelper, 3000)
  end
end

local function simpleJson(t)
  local res = {}
  for k,v in pairs(t) do
    table.insert(res, string.format('"%s":"%s"', tostring(k), tostring(v)))
  end
  return "{" .. table.concat(res, ",") .. "}"
end

function sendToHelper(data)
  if helperWs then
    local ok, encoded
    if type(data) == 'table' and not data.members and not data.devices then
      encoded = simpleJson(data)
      ok = true
    else
      ok, encoded = pcall(function() return json.encode(data) end)
    end
    
    if ok then
      pcall(function() helperWs.send(encoded) end)
    end
  end
end

function sendPingToHelper()
  if helperWs then sendToHelper({ type = 'ping' }) end
  updateGlobalStatus()
  scheduleEvent(sendPingToHelper, 5000)
end

function updateGlobalStatus()
  local status = 'offline'
  if helperWs and g_game.isOnline() then
    local memberList = voipWindow:recursiveGetChildById('voipMemberList')
    if memberList and memberList:getChildCount() > 0 then status = 'stable' end
  end
  if modules.game_stats and modules.game_stats.updateVoipStatus then
    modules.game_stats.updateVoipStatus(status)
  end
end

function sendReport()
  if not g_game.isOnline() then return end
  local now = os.time()
  if now - lastReportTime < 600 then
    local remaining = math.ceil((600 - (now - lastReportTime)) / 60)
    modules.game_textmessage.displayFailureMessage(tr('Voce deve aguardar ' .. remaining .. ' minutos antes de realizar outro report.'))
    return
  end

  local confirmBox
  confirmBox = displayGeneralBox(tr('Report Party'), tr('Deseja reportar o audio desta party? Um "Instant Replay" dos ultimos 60 segundos sera gerado para moderacao.'), {
    { text = tr('Confirmar'), callback = function()
        sendToHelper({ type = 'REPORT_GENERAL' })
        g_game.getProtocolGame():sendExtendedOpcode(OPCODE_SPEAKING, "REPORT")
        lastReportTime = os.time()
        modules.game_textmessage.displayStatusMessage(tr('Gerando protocolo de denuncia. Aguarde...'))
        if confirmBox then confirmBox:destroy() confirmBox = nil end
    end },
    { text = tr('Cancelar'), callback = function() if confirmBox then confirmBox:destroy() confirmBox = nil end end }
  })
end

function terminate()
  removeEvent(voipUpdateEvent)
  ProtocolGame.unregisterExtendedOpcode(OPCODE_VOIP)
  ProtocolGame.unregisterExtendedOpcode(OPCODE_SESSION)
  ProtocolGame.unregisterOpcode(0xE0)
  ProtocolGame.unregisterOpcode(0xE1)
  disconnect(g_game, { onGameStart = onGameStart, onGameEnd = clearMembers })
  if checkPttEvent then removeEvent(checkPttEvent) checkPttEvent = nil end
  if pttBinding then
    g_keyboard.unbindKeyDown(pttBinding)
    g_keyboard.unbindKeyUp(pttBinding)
  end
  if voipButton then voipButton:destroy() end
  if voipWindow then voipWindow:destroy() end
end

function toggle()
  if voipButton:isOn() then voipWindow:close() voipButton:setOn(false)
  else voipWindow:open() voipButton:setOn(true) end
end

function onMiniWindowClose() voipButton:setOn(false) end
function onGameStart() clearMembers() updatePttBinding() end

function updateBars()
  removeEvent(voipUpdateEvent)
  voipUpdateEvent = scheduleEvent(updateBars, 500)
  if not voipWindow or not g_game.isOnline() then return end
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if not memberList then return end
  for name, data in pairs(partyData) do
    local widget = memberList:getChildById(name)
    if widget then
      local creature = getCreatureByName(name)
      if creature and creature:isLocalPlayer() then
        widget:getChildById('healthBar'):setValue(creature:getHealthPercent(), 0, 100)
      end
    end
  end
end

function onVoipUpdate(protocol, opcode, buffer)
  if opcode ~= OPCODE_VOIP then return end
  if buffer == "" then clearMembers() return end
  local label = voipWindow:recursiveGetChildById('descriptionLabel')
  if label then label:hide() end

  local membersData = split(buffer, "|")
  local currentMembers = {}
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')

  for i, memberData in ipairs(membersData) do
    local parts = split(memberData, ";")
    if #parts >= 4 then
      local name = parts[1]
      local vocID = tonumber(parts[2]) or 0
      local outfitparts = split(parts[3], ",")
      local healthPercent = tonumber(parts[4]) or 0
      local manaPercent = tonumber(parts[5]) or 0
      local id = tonumber(parts[6]) or 0
      local isSpeaking = (tonumber(parts[7]) == 1)
      local isLeader = (i == 1)
      
      local outfit = {
        type   = tonumber(outfitparts[1]) or 0,
        head   = tonumber(outfitparts[2]) or 0,
        body   = tonumber(outfitparts[3]) or 0,
        legs   = tonumber(outfitparts[4]) or 0,
        feet   = tonumber(outfitparts[5]) or 0,
        addons = tonumber(outfitparts[6]) or 0,
      }

      partyData[name] = { id = id, vocID = vocID, isLeader = isLeader, isSpeaking = isSpeaking, outfit = outfit, latency = 0, status = 'offline' }
      addMember(name, VOCATION_INFO[vocID] and VOCATION_INFO[vocID].name or "None", isLeader, outfit, healthPercent, manaPercent)
      currentMembers[name] = true
    end
  end

  for _, child in ipairs(memberList:getChildren()) do
    local childName = child:getId()
    if not currentMembers[childName] then partyData[childName] = nil child:destroy() end
  end
  if not voipUpdateEvent then voipUpdateEvent = scheduleEvent(updateBars, 500) end
  updateGlobalStatus()
end

function onExtendedVoipSession(protocol, opcode, buffer)
  if not buffer or buffer == "" then return end
  local ok, data = pcall(function() return json.decode(buffer) end)
  if not ok then return end
  local session = data
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if voipWindow:recursiveGetChildById('descriptionLabel') then voipWindow:recursiveGetChildById('descriptionLabel'):hide() end

  local currentMembers = {}
  for _, member in ipairs(session.members) do
    partyData[member.name] = { id = member.playerId, vocID = member.vocation, isLeader = member.isLeader }
    addMember(member.name, VOCATION_INFO[member.vocation] and VOCATION_INFO[member.vocation].name or "None", member.isLeader, nil, 100, 100)
    currentMembers[member.name] = true
  end

  for _, child in ipairs(memberList:getChildren()) do
    local childName = child:getId()
    if not currentMembers[childName] then partyData[childName] = nil child:destroy() end
  end
  voipWindow:open()
  voipButton:setOn(true)
  if not voipUpdateEvent then voipUpdateEvent = scheduleEvent(updateBars, 500) end
  updateGlobalStatus()
  sendToHelper({ type = 'CONNECT', wsUrl = session.wsUrl, sessionKey = session.sessionKey })
end

function onVoipSession(protocol, msg)
  local session = { roomId = msg:getString(), sessionKey = msg:getString(), wsUrl = msg:getString(), selfPlayerId = msg:getU32(), members = {} }
  local memberCount = msg:getU8()
  local currentMembers = {}
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if voipWindow:recursiveGetChildById('descriptionLabel') then voipWindow:recursiveGetChildById('descriptionLabel'):hide() end

  for i = 1, memberCount do
    local name = msg:getString()
    local member = { playerId = msg:getU32(), name = name, vocation = msg:getU8(), isLeader = msg:getU8() == 1, mutedGlobal = msg:getU8() == 1 }
    partyData[name] = { id = member.playerId, vocID = member.vocation, isLeader = member.isLeader }
    if member.mutedGlobal then mutedGlobals[member.playerId] = true end
    addMember(name, VOCATION_INFO[member.vocation] and VOCATION_INFO[member.vocation].name or "None", member.isLeader, nil, 100, 100)
    currentMembers[name] = true
  end

  for _, child in ipairs(memberList:getChildren()) do
    local childName = child:getId()
    if not currentMembers[childName] then partyData[childName] = nil child:destroy() end
  end
  voipWindow:open()
  voipButton:setOn(true)
  if not voipUpdateEvent then voipUpdateEvent = scheduleEvent(updateBars, 500) end
  updateGlobalStatus()
  sendToHelper({ type = 'CONNECT', wsUrl = session.wsUrl, sessionKey = session.sessionKey })
end

function onVoipClose(protocol, msg)
  voipWindow:close()
  voipButton:setOn(false)
  clearMembers()
end

function clearMembers()
  partyData = {}
  mutedPlayers = {}
  mutedGlobals = {}
  mutedGlobalVocations = {}
  isGlobalMuted = false
  removeEvent(voipUpdateEvent)
  voipUpdateEvent = nil
  if not voipWindow then return end
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if memberList then memberList:destroyChildren() end
  updateGlobalStatus()
  local label = voipWindow:recursiveGetChildById('descriptionLabel')
  if label then label:setText(tr('No active call.')) label:show() end
end

function addMember(name, vocation, isLeader, outfit, healthPercent, manaPercent)
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if not memberList then return end
  local widget = memberList:getChildById(name)
  if not widget then
    widget = g_ui.createWidget('VoipMember', memberList)
    widget:setId(name)
  end

  local displayName = isLeader and (name .. " (L)") or name
  widget:getChildById('name'):setText(displayName)
  widget:getChildById('name'):setColor(isLeader and '#FFD700' or '#FFFFFF')
  widget:getChildById('vocationName'):setText(vocation)
  if outfit then widget:getChildById('creature'):setOutfit(outfit) end
  widget:getChildById('healthBar'):setValue(healthPercent, 0, 100)
  widget:getChildById('manaBar'):setValue(manaPercent, 0, 100)
  
  local isLeaderUI = isLocalLeader()
  local globalVocPanel = voipWindow:recursiveGetChildById('globalVocationPanel')
  if globalVocPanel then
    globalVocPanel:setVisible(isLeaderUI)
    globalVocPanel:setHeight(isLeaderUI and 22 or 0)
    globalVocPanel:setMarginTop(isLeaderUI and 2 or 0)
  end
  
  local globalAllBtn = voipWindow:recursiveGetChildById('GlobalAll')
  local localAllBtn = voipWindow:recursiveGetChildById('All')
  if globalAllBtn and localAllBtn then
    globalAllBtn:setVisible(isLeaderUI)
    localAllBtn:setVisible(not isLeaderUI)
  end

  widget.onMouseRelease = onMemberClick
  refreshMemberUI(name)
end

function refreshMemberUI(name)
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if not memberList then return end
  local widget = memberList:getChildById(name)
  if not widget then return end
  local data = partyData[name]
  if not data then return end

  local vocMuteId = VOCATION_MUTE_ID[data.vocID] or "All"
  local isMutedLocally = mutedVocations["All"] or mutedVocations[vocMuteId] or mutedPlayers[name]
  local isMutedGlobally = isGlobalMuted or mutedGlobals[data.id] or (mutedGlobalVocations[data.vocID] == true)
  if data.isLeader then isMutedGlobally = false end

  local isSpeaking = data.isSpeaking
  if name == g_game.getCharacterName() then isSpeaking = pttPressed end

  local statusBall = widget:getChildById('statusBall')
  if isMutedGlobally then statusBall:setBackgroundColor('#888888')
  elseif isMutedLocally then statusBall:setBackgroundColor('#ff0000')
  elseif isSpeaking then statusBall:setBackgroundColor('#00ff00')
  else statusBall:setBackgroundColor('#444444') end
end

function cycleSpeakingAnimation()
  scheduleEvent(cycleSpeakingAnimation, 100)
  if not voipWindow or not voipWindow:isVisible() then return end
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if not memberList then return end
  local alpha = math.sin(g_clock.millis() / 150) * 0.3 + 0.7
  for name, data in pairs(partyData) do
    if data.isSpeaking or (name == g_game.getCharacterName() and pttPressed) then
      local widget = memberList:getChildById(name)
      if widget then
        local statusBall = widget:getChildById('statusBall')
        if statusBall:getBackgroundColor() == '#00ff00' then statusBall:setOpacity(alpha) else statusBall:setOpacity(1.0) end
      end
    end
  end
end

function onMuteClick(widget)
  local id = widget:getId()
  local checked = widget:isChecked() -- Já foi alterado pelo motor do OTClient por ser um UICheckBox
  local vocationPanel = voipWindow:recursiveGetChildById('vocationPanel')
  if id == "All" then
    if vocationPanel then 
      for _, child in ipairs(vocationPanel:getChildren()) do 
        child:setChecked(checked) 
        mutedVocations[child:getId()] = checked 
        local vocId = -1
        for k, v in pairs(VOCATION_MUTE_ID) do if v == child:getId() then vocId = k break end end
        if vocId ~= -1 then sendToHelper({ type = 'MUTE_VOCATION', vocId = vocId, muted = checked, isGlobal = false }) end
      end 
    end
    mutedVocations["All"] = checked
  else
    mutedVocations[id] = checked
    local vocId = -1
    for k, v in pairs(VOCATION_MUTE_ID) do if v == id then vocId = k break end end
    if vocId ~= -1 then sendToHelper({ type = 'MUTE_VOCATION', vocId = vocId, muted = checked, isGlobal = false }) end
    
    local allChecked = true
    if vocationPanel then for _, child in ipairs(vocationPanel:getChildren()) do if not child:isChecked() then allChecked = false break end end end
    local allBtn = voipWindow:recursiveGetChildById('All')
    if allBtn then allBtn:setChecked(allChecked) end
    mutedVocations["All"] = allChecked
  end
  for name, _ in pairs(partyData) do refreshMemberUI(name) end
end

function onGlobalMuteClick(widget)
  if not isLocalLeader() then return end
  local id = widget:getId()
  local checked = widget:isChecked() -- Já foi alterado pelo motor
  if id == "GlobalAll" then sendToHelper({ type = 'GLOBAL_MUTE', muted = checked })
  else
    local vocName = id:sub(3)
    local vocId = -1
    for k, v in pairs(VOCATION_MUTE_ID) do if v == vocName then vocId = k break end end
    if vocId ~= -1 then sendToHelper({ type = 'MUTE_VOCATION', vocId = vocId, muted = checked, isGlobal = true }) end
  end
end

function onMemberMuteClick(widget) togglePlayerMute(widget:getParent():getId(), false) end
function onMemberGlobalMuteClick(widget) togglePlayerMute(widget:getParent():getId(), true) end

function togglePlayerMute(name, isGlobal)
  local data = partyData[name]
  if not data or data.isLeader then return end
  if isGlobal then
    if not isLocalLeader() then return end
    local newState = not (mutedGlobals[data.id] == true)
    sendToHelper({ type = 'MUTE_MEMBER', targetId = data.id, muted = newState, isGlobal = true })
  else
    mutedPlayers[name] = not mutedPlayers[name]
    sendToHelper({ type = 'MUTE_MEMBER', targetId = data.id, muted = mutedPlayers[name], isGlobal = false })
  end
  refreshMemberUI(name)
end

function onMemberClick(widget, mousePos, mouseButton)
  if mouseButton == MouseRightButton then
    local name = widget:getId()
    if name == g_game.getCharacterName() then return end
    local data = partyData[name]
    if not data then return end
    local menu = g_ui.createWidget('PopupMenu')
    menu:setGameMenu(true)
    menu:addOption('Seguir', function() local c = getCreatureByName(name) if c then g_game.follow(c) end end)
    menu:addOption('Mandar mensagem', function() g_game.openPrivateChannel(name) end)
    if not data.isLeader then
      local isLocallyMuted = (mutedPlayers[name] == true)
      menu:addOption(isLocallyMuted and 'Parar de ignorar' or 'Ignorar jogador', function() togglePlayerMute(name, false) end)
    end
    if isLocalLeader() and not data.isLeader then
      local isGloballyMuted = (mutedGlobals[data.id] == true)
      menu:addOption(isGloballyMuted and 'Desmutar para todos' or 'Mutar para todos', function() togglePlayerMute(name, true) end)
    end
    menu:display(mousePos)
    return true
  end
end

function updatePttBinding()
  if not g_game.isOnline() then scheduleEvent(updatePttBinding, 1000) return end
  local charName = g_game.getCharacterName()
  local newBinding = g_settings.getString('voipPtt_' .. charName, '')
  if newBinding == pttBinding then scheduleEvent(updatePttBinding, 500) return end
  local root = modules.game_interface.getRootPanel()
  if pttBinding and pttBinding ~= "" then
    if pttBinding:find("Mouse") then disconnect(root, { onMousePress = onMousePTTKeyDown, onMouseRelease = onMousePTTKeyUp })
    else g_keyboard.unbindKeyDown(pttBinding, onPTTKeyDown) g_keyboard.unbindKeyUp(pttBinding, onPTTKeyUp) end
  end
  pttBinding = newBinding
  if pttBinding and pttBinding ~= "" then
    if pttBinding:find("Mouse") then connect(root, { onMousePress = onMousePTTKeyDown, onMouseRelease = onMousePTTKeyUp })
    else g_keyboard.bindKeyDown(pttBinding, onPTTKeyDown) g_keyboard.bindKeyUp(pttBinding, onPTTKeyUp) end
  end
  scheduleEvent(updatePttBinding, 500)
end

function getMouseButtonName(mouseButton)
  if mouseButton == MouseLeftButton then return "MouseLeft"
  elseif mouseButton == MouseRightButton then return "MouseRight"
  elseif mouseButton == MouseMidButton then return "MouseMiddle"
  elseif mouseButton == MouseButton4 then return "Mouse4"
  elseif mouseButton == MouseButton5 then return "Mouse5" end
  return "Mouse" .. tostring(mouseButton)
end

function onMousePTTKeyDown(self, mousePos, mouseButton) if getMouseButtonName(mouseButton) == pttBinding then onPTTKeyDown() return true end end
function onMousePTTKeyUp(self, mousePos, mouseButton) if getMouseButtonName(mouseButton) == pttBinding then onPTTKeyUp() return true end end

function onPTTKeyDown()
  if not g_game.isOnline() then return end
  pttPressed = true
  local protocol = g_game.getProtocolGame()
  if protocol then protocol:sendExtendedOpcode(OPCODE_SPEAKING, "1") end
  sendToHelper({ type = 'START_TALK' })
  refreshMemberUI(g_game.getCharacterName())
end

function onPTTKeyUp()
  if not g_game.isOnline() then return end
  pttPressed = false
  local protocol = g_game.getProtocolGame()
  if protocol then protocol:sendExtendedOpcode(OPCODE_SPEAKING, "0") end
  sendToHelper({ type = 'STOP_TALK' })
  refreshMemberUI(g_game.getCharacterName())
end

function checkPttState()
  checkPttEvent = scheduleEvent(checkPttState, 100)
  if not pttPressed then return end
  if not g_window.hasFocus() then onPTTKeyUp() return end
  if pttBinding and pttBinding:find("Mouse") then
    local btn = nil
    if pttBinding == "MouseLeft" then btn = MouseLeftButton
    elseif pttBinding == "MouseRight" then btn = MouseRightButton
    elseif pttBinding == "MouseMiddle" then btn = MouseMiddleButton
    elseif pttBinding == "Mouse4" then btn = MouseButton4
    elseif pttBinding == "Mouse5" then btn = MouseButton5 end
    if btn and not g_mouse.isPressed(btn) then onPTTKeyUp() end
  end
end

function isLocalLeader() local p = g_game.getLocalPlayer() return p and p:isPartyLeader() end
function getDevices() sendToHelper({ type = 'LIST_DEVICES' }) end
function setDevice(id) sendToHelper({ type = 'SET_DEVICE', deviceId = id }) end
function getDevicesOut() sendToHelper({ type = 'LIST_DEVICES_OUT' }) end
function setDeviceOut(id) sendToHelper({ type = 'SET_DEVICE_OUT', deviceId = id }) end
function startTest() sendToHelper({ type = 'TEST_START' }) end
function stopTest() sendToHelper({ type = 'TEST_STOP' }) end
function setMicGain(v) sendToHelper({ type = 'SET_MIC_GAIN', value = v }) end
function setSpeakerVolume(v) sendToHelper({ type = 'SET_SPEAKER_VOLUME', value = v }) end
function setInputProfile(p) sendToHelper({ type = 'SET_INPUT_PROFILE', value = p }) end
function setSensitivity(v) sendToHelper({ type = 'SET_SENSITIVITY', value = v }) end
