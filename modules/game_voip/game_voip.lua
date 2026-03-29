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
}

-- Maps vocation id ranges to mute button ids
local VOCATION_MUTE_ID = {
  [0] = "All",
  [1] = "Sorcerer", [5] = "Sorcerer",
  [2] = "Druid",    [6] = "Druid",
  [3] = "Paladin",  [7] = "Paladin",
  [4] = "Knight",   [8] = "Knight",
  [9] = "Monk",
}

-- member data stored by name, populated from server opcode
local partyData = {}  -- {name -> {vocID, isLeader, id}}
local mutedVocations = {}
local mutedPlayers = {}      -- mute LOCAL: jogadores ignorados por mim nesta sessão
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
        -- Notificação vinda do servidor: líder alterou o mute global da sala
        isGlobalMuted = data.muted
        local estado = data.muted and 'ATIVADO' or 'DESATIVADO'
        local msg = 'Mute global ' .. estado .. ' pelo líder ' .. tostring(data.byLeader) .. '.'
        if not data.muted or isLocalLeader() then
          modules.game_textmessage.displayStatusMessage(msg)
        end
        -- Atualizar indicadores visuais de todos os membros
        for name, _ in pairs(partyData) do
          refreshMemberUI(name)
        end

      elseif data.type == 'mute_member_ack' then
        -- Confirmação do servidor que o mute local foi aplicado
        print('[VoIP] Mute local confirmado pelo servidor: ID ' .. tostring(data.targetPlayerId) .. ' -> ' .. tostring(data.muted))

      elseif data.type == 'error' then
        modules.game_textmessage.displayFailureMessage('[VoIP] ' .. tostring(data.message))

      elseif data.type == 'DEVICE_LIST' then
        print(">> [VoIP] Received Device List: " .. #data.devices .. " devices")
        if modules.client_options and modules.client_options.updateDeviceList then
          modules.client_options.updateDeviceList(data.devices)
        end
      elseif data.type == 'DEVICE_LIST_OUT' then
        print(">> [VoIP] Received Speaker List: " .. #data.devices .. " devices")
        if modules.client_options and modules.client_options.updateSpeakerList then
          modules.client_options.updateSpeakerList(data.devices)
        end
      elseif data.type == 'report_response' then
        if data.success then
          displayInfoBox(tr('Report Protocol'), tr('Sua denúncia foi registrada com sucesso sob o Protocolo: #') .. tostring(data.protocol) .. tr('\n\nUse este número ao abrir um ticket no website do jogo.'))
        else
          modules.game_textmessage.displayFailureMessage(tr('Erro no Report: ') .. tostring(data.error))
        end
      end
    end,
    onClose = function()
      print(">> [VoIP] Local Helper disconnected.")
      if modules.client_background then
        modules.client_background.updateVoipStatus(false)
      end
      helperWs = nil
      -- Reset UI for all members
      for name, _ in pairs(partyData) do
        if partyData[name] then
           partyData[name].status = 'offline'
           refreshMemberUI(name)
        end
      end

      if not helperRetryEvent then
        print(">> [VoIP] Reconnecting in 3s...")
        helperRetryEvent = scheduleEvent(connectToHelper, 3000)
      end
    end,
    onError = function(err)
      print(">> [VoIP] Local Helper error: " .. err)
      if modules.client_background then
        modules.client_background.updateVoipStatus(false)
      end
      -- Se a conexão falhar (ex: recusada), tentar iniciar o helper automaticamente
      if not helperLaunched then
         helperLaunched = true
         print(">> [VoIP] Helper not detected via error. Attempting automatic launch (hidden mode)...")
         -- Tenta rodar via VBScript para ocultar a janela do terminal
         os.execute('wscript.exe "voip-helper.vbs"')
      end
    end
  }
  
  local ok, res = pcall(function() return HTTP.webSocketJSON("ws://127.0.0.1:3002/", callbacks) end)
  if ok then
    helperWs = res
    if helperRetryEvent then 
      removeEvent(helperRetryEvent) 
      helperRetryEvent = nil 
    end
  else
    -- Este erro de pcall só ocorreria se a função HTTP.webSocketJSON falhasse internamente (raro)
    if not helperRetryEvent then
      helperRetryEvent = scheduleEvent(connectToHelper, 3000)
    end
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
    -- For simple commands, use manual encoder to avoid json.lua issues
    if type(data) == 'table' and not data.members and not data.devices then
      encoded = simpleJson(data)
      ok = true
    else
      ok, encoded = pcall(function() return json.encode(data) end)
    end
    
    if ok then
      local sendOk, err = pcall(function() return helperWs.send(encoded) end)
      if not sendOk then
        -- print(">> [VoIP] Error sending to Helper: " .. tostring(err))
      end
    else
      print(">> [VoIP] Error encoding JSON for Helper: " .. tostring(encoded))
    end
  else
    print(">> [VoIP] Error: Cannot send to Helper (Socket not connected)")
  end
end

function sendPingToHelper()
  if helperWs then
    sendToHelper({ type = 'ping' })
  end
  updateGlobalStatus()
  scheduleEvent(sendPingToHelper, 5000)
end

function updateGlobalStatus()
  local status = 'offline'
  if helperWs and g_game.isOnline() then
    local memberList = voipWindow:recursiveGetChildById('voipMemberList')
    if memberList and memberList:getChildCount() > 0 then
      status = 'stable'
      -- Futuro: checar latência média para 'unstable'
    end
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
  confirmBox = displayGeneralBox(tr('Report Party'), tr('Deseja reportar o audio desta party? Um "Instant Replay" dos ultimos 60 segundos sera gerado para moderacao.\n(Voce podera realizar outro report em 10 minutos)'), {
    { text = tr('Confirmar'), callback = function()
        print("[VoIP] Sending General Report Request")
        sendToHelper({ type = 'REPORT_GENERAL' })
        g_game.getProtocolGame():sendExtendedOpcode(OPCODE_SPEAKING, "REPORT")
        
        lastReportTime = os.time()
        modules.game_textmessage.displayStatusMessage(tr('Denuncia enviada com sucesso. O replay da party sera analisado.'))
        
        if confirmBox then
          confirmBox:destroy()
          confirmBox = nil
        end
    end },
    { text = tr('Cancelar'), callback = function() 
        if confirmBox then
          confirmBox:destroy() 
          confirmBox = nil
        end
    end }
  })
end

function terminate()
  removeEvent(voipUpdateEvent)
  ProtocolGame.unregisterExtendedOpcode(OPCODE_VOIP)
  ProtocolGame.unregisterExtendedOpcode(OPCODE_SESSION)
  ProtocolGame.unregisterOpcode(0xE0)
  ProtocolGame.unregisterOpcode(0xE1)
  disconnect(g_game, { onGameStart = onGameStart, onGameEnd = clearMembers })
  
  if checkPttEvent then
    removeEvent(checkPttEvent)
    checkPttEvent = nil
  end

  if pttBinding then
    g_keyboard.unbindKeyDown(pttBinding)
    g_keyboard.unbindKeyUp(pttBinding)
  end
  if voipButton then voipButton:destroy() end
  if voipWindow then voipWindow:destroy() end
end

function toggle()
  if voipButton:isOn() then
    voipWindow:close()
    voipButton:setOn(false)
  else
    voipWindow:open()
    voipButton:setOn(true)
  end
end

function onMiniWindowClose()
  voipButton:setOn(false)
end

function onGameStart()
  clearMembers()
  updatePttBinding()
end

-- Called every 500ms to update HP/mana bars from local creature objects
function updateBars()
  removeEvent(voipUpdateEvent)
  voipUpdateEvent = scheduleEvent(updateBars, 500)

  if not voipWindow or not g_game.isOnline() then return end
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if not memberList then return end

  for name, data in pairs(partyData) do
    local widget = memberList:getChildById(name)
    if widget then
      -- ONLY update bars locally if the creature is visible AND it's the local player.
      -- For others, we rely on the server updates to avoid oscillation between different precision values.
      local creature = getCreatureByName(name)
      if creature and creature:isLocalPlayer() then
        local hp = creature:getHealthPercent()
        widget:getChildById('healthBar'):setValue(hp, 0, 100)
      end
    end
  end
end

function onVoipUpdate(protocol, opcode, buffer)
  if opcode ~= OPCODE_VOIP then return end

  if buffer == "" then
    clearMembers()
    return
  end

  local label = voipWindow:recursiveGetChildById('descriptionLabel')
  if label then label:hide() end

  local membersData = split(buffer, "|")
  local currentMembers = {}
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')

  for i, memberData in ipairs(membersData) do
    -- Format: Name;VocID;lookType,head,body,legs,feet,addons;health%;mana%
    local parts = split(memberData, ";")
    if #parts >= 4 then
      local name = parts[1]
      local vocID = tonumber(parts[2]) or 0
      local outfitparts = split(parts[3], ",")
      local healthPercent = tonumber(parts[4]) or 0
      local manaPercent = tonumber(parts[5]) or 0
      local id = tonumber(parts[6]) or 0
      local isSpeakingRaw = parts[7]
      local isSpeaking = (tonumber(isSpeakingRaw) == 1)
      local isLeader = (i == 1)

      print("[VoIP] Parsing member: " .. name .. " | ID: " .. id .. " | SpeakingRaw: " .. tostring(isSpeakingRaw) .. " | isSpeaking: " .. tostring(isSpeaking))

      local vocName = VOCATION_INFO[vocID] and VOCATION_INFO[vocID].name or "None"
      local outfit = {
        type   = tonumber(outfitparts[1]) or 0,
        head   = tonumber(outfitparts[2]) or 0,
        body   = tonumber(outfitparts[3]) or 0,
        legs   = tonumber(outfitparts[4]) or 0,
        feet   = tonumber(outfitparts[5]) or 0,
        addons = tonumber(outfitparts[6]) or 0,
      }

      partyData[name] = { 
        id = id, 
        vocID = vocID, 
        outfit = outfit, 
        isLeader = isLeader, 
        isSpeaking = isSpeaking,
        latency = 0,
        status = 'offline'
      }
      
      addMember(name, vocName, isLeader, outfit, healthPercent, manaPercent)
      currentMembers[name] = true
    end
  end

  -- Remove members that left
  for _, child in ipairs(memberList:getChildren()) do
    local childName = child:getId()
    if not currentMembers[childName] then
      partyData[childName] = nil
      child:destroy()
    end
  end

  -- Start the live update loop if not already running
  if not voipUpdateEvent then
    voipUpdateEvent = scheduleEvent(updateBars, 500)
  end
  updateGlobalStatus()
end

function onExtendedVoipSession(protocol, opcode, buffer)
  if not buffer or buffer == "" then return end
  
  local ok, data = pcall(function() return json.decode(buffer) end)
  if not ok then
    print(">> [VoIP] Error decoding session JSON: " .. tostring(data))
    return
  end

  local session = data
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  
  if voipWindow:recursiveGetChildById('descriptionLabel') then
    voipWindow:recursiveGetChildById('descriptionLabel'):hide()
  end

  local currentMembers = {}
  for _, member in ipairs(session.members) do
    local name = member.name
    local vocName = VOCATION_INFO[member.vocation] and VOCATION_INFO[member.vocation].name or "None"
    
    partyData[name] = { id = member.playerId, vocID = member.vocation, isLeader = member.isLeader }
    addMember(name, vocName, member.isLeader, nil, 100, 100)
    currentMembers[name] = true
  end

  -- Remove members that left
  for _, child in ipairs(memberList:getChildren()) do
    local childName = child:getId()
    if not currentMembers[childName] then
      partyData[childName] = nil
      child:destroy()
    end
  end

  voipWindow:open()
  voipButton:setOn(true)

  if not voipUpdateEvent then
    voipUpdateEvent = scheduleEvent(updateBars, 500)
  end
  updateGlobalStatus()

  -- Notify Helper about new session
  print(">> [VoIP] Session Join (JSON): " .. session.wsUrl .. " | Room: " .. session.roomId)
  sendToHelper({
    type = 'CONNECT',
    wsUrl = session.wsUrl,
    sessionKey = session.sessionKey
  })
end

function onVoipSession(protocol, msg)
  local session = {
    roomId = msg:getString(),
    sessionKey = msg:getString(),
    wsUrl = msg:getString(),
    selfPlayerId = msg:getU32(),
    members = {}
  }

  local memberCount = msg:getU8()
  local currentMembers = {}
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  
  if voipWindow:recursiveGetChildById('descriptionLabel') then
    voipWindow:recursiveGetChildById('descriptionLabel'):hide()
  end

  for i = 1, memberCount do
    local name = msg:getString()
    local member = {
      playerId = msg:getU32(),
      name = name,
      vocation = msg:getU8(),
      isLeader = msg:getU8() == 1,
      mutedGlobal = msg:getU8() == 1
    }
    
    local vocName = VOCATION_INFO[member.vocation] and VOCATION_INFO[member.vocation].name or "None"
    
    partyData[name] = { id = member.playerId, vocID = member.vocation, isLeader = member.isLeader }
    addMember(name, vocName, member.isLeader, nil, 100, 100)
    currentMembers[name] = true
  end

  -- Remove members that left
  for _, child in ipairs(memberList:getChildren()) do
    local childName = child:getId()
    if not currentMembers[childName] then
      partyData[childName] = nil
      child:destroy()
    end
  end

  voipWindow:open()
  voipButton:setOn(true)

  if not voipUpdateEvent then
    voipUpdateEvent = scheduleEvent(updateBars, 500)
  end
  updateGlobalStatus()

  -- Notify Helper about new session
  print(">> [VoIP] Session Join: " .. session.wsUrl .. " | Room: " .. session.roomId)
  sendToHelper({
    type = 'CONNECT',
    wsUrl = session.wsUrl,
    sessionKey = session.sessionKey
  })
end

function onVoipClose(protocol, msg)
  local roomId = msg:getString()
  voipWindow:close()
  voipButton:setOn(false)
  clearMembers()
end

function clearMembers()
  partyData = {}
  mutedPlayers = {}
  isGlobalMuted = false
  removeEvent(voipUpdateEvent)
  voipUpdateEvent = nil
  if not voipWindow then return end
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if memberList then memberList:destroyChildren() end
  updateGlobalStatus()
  local label = voipWindow:recursiveGetChildById('descriptionLabel')
  if label then
    label:setText(tr('No active call.'))
    label:show()
  end
end

function addMember(name, vocation, isLeader, outfit, healthPercent, manaPercent)
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if not memberList then return end

  local widget = memberList:getChildById(name)
  if not widget then
    widget = g_ui.createWidget('VoipMember', memberList)
    if not widget then
      print(">> [VoIP] Erro: Falha ao criar widget VoipMember para " .. tostring(name))
      return
    end
    widget:setId(name)
  end

  local displayName = isLeader and (name .. " (L)") or name
  widget:getChildById('name'):setText(displayName)
  widget:getChildById('name'):setColor(isLeader and '#FFD700' or '#FFFFFF')
  widget:getChildById('vocationName'):setText(vocation)
  if outfit then widget:getChildById('creature'):setOutfit(outfit) end
  widget:getChildById('healthBar'):setValue(healthPercent, 0, 100)
  widget:getChildById('manaBar'):setValue(manaPercent, 0, 100)
  
  -- Explicitly bind click event to ensure it works
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
  -- Mute LOCAL por vocação ou por jogador individual
  local isMutedLocally = mutedVocations["All"] or mutedVocations[vocMuteId] or mutedPlayers[name]
  -- O líder nunca aparece como mutado na UI, independente de qualquer flag
  if data.isLeader then isMutedLocally = false end

  local isSpeaking = data.isSpeaking
  if name == g_game.getCharacterName() then
    isSpeaking = pttPressed
  end

  local statusBall = widget:getChildById('statusBall')
  if isMutedLocally then
    statusBall:setBackgroundColor('#ff0000') -- Red for muted
  elseif isGlobalMuted and not data.isLeader then
    statusBall:setBackgroundColor('#888888') -- Gray for global mute
  elseif isSpeaking then
    statusBall:setBackgroundColor('#00ff00') -- Green for speaking
  else
    statusBall:setBackgroundColor('#444444') -- Dark gray for idle
  end

  -- Vocação/Latência removido para design minimalista.
end

function cycleSpeakingAnimation()
  scheduleEvent(cycleSpeakingAnimation, 100)
  if not voipWindow or not voipWindow:isVisible() then return end

  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if not memberList then return end

  local time = g_clock.millis()
  local alpha = math.sin(time / 150) * 0.3 + 0.7 -- Pulse between 0.4 and 1.0 opacity

  for name, data in pairs(partyData) do
    if data.isSpeaking or (name == g_game.getCharacterName() and pttPressed) then
      local widget = memberList:getChildById(name)
      if widget then
        local statusBall = widget:getChildById('statusBall')
        if statusBall:getBackgroundColor() == '#00ff00' then
          statusBall:setOpacity(alpha)
        else
          statusBall:setOpacity(1.0)
        end
      end
    end
  end
end

function onVolumeChange(widget, value)
  local memberWidget = widget:getParent()
  local name = memberWidget:getId()
  print("[VoIP] Changing volume for " .. name .. " to " .. value .. "%")
  
  -- Send to helper to adjust local gain for this stream
  sendToHelper({ 
    type = 'SET_VOLUME', 
    targetPlayerId = partyData[name] and partyData[name].id or 0,
    value = value 
  })
end

function onIndividualMute(widget)
  local memberWidget = widget:getParent()
  local name = memberWidget:getId()
  local checked = widget:isChecked()
  
  print("[VoIP] Local Mute " .. (checked and "ON" or "OFF") .. " for " .. name)
  mutedPlayers[name] = checked
  
  -- Sincronizar com o servidor VoIP (para ele parar de enviar os pacotes para nós e economizar banda)
  local protocol = g_game.getProtocolGame()
  if protocol and partyData[name] then
    sendToHelper({
      type = 'mute_member',
      targetPlayerId = partyData[name].id,
      muted = checked
    })
  end
  
  refreshMemberUI(name)
end

function updatePttBinding()
  if not g_game.isOnline() then
    scheduleEvent(updatePttBinding, 1000)
    return
  end

  local charName = g_game.getCharacterName()
  local newBinding = g_settings.getString('voipPtt_' .. charName, '')
  if newBinding == "None" or newBinding == "none" then
    newBinding = ""
  end

  if newBinding == pttBinding then 
    scheduleEvent(updatePttBinding, 500)
    return 
  end

  local root = modules.game_interface.getRootPanel()
  if pttBinding and pttBinding ~= "" then
    if pttBinding:find("Mouse") then
      disconnect(root, { onMousePress = onMousePTTKeyDown, onMouseRelease = onMousePTTKeyUp })
    else
      g_keyboard.unbindKeyDown(pttBinding, onPTTKeyDown)
      g_keyboard.unbindKeyUp(pttBinding, onPTTKeyUp)
    end
  end

  pttBinding = newBinding
  if pttBinding and pttBinding ~= "" then
    print("[VoIP] Binding PTT to: " .. pttBinding)
    if pttBinding:find("Mouse") then
      connect(root, { onMousePress = onMousePTTKeyDown, onMouseRelease = onMousePTTKeyUp })
    else
      g_keyboard.bindKeyDown(pttBinding, onPTTKeyDown)
      g_keyboard.bindKeyUp(pttBinding, onPTTKeyUp)
    end
  end
  
  scheduleEvent(updatePttBinding, 500)
end

function getMouseButtonName(mouseButton)
  if mouseButton == MouseLeftButton then return "MouseLeft"
  elseif mouseButton == MouseRightButton then return "MouseRight"
  elseif mouseButton == MouseMidButton then return "MouseMiddle"
  elseif mouseButton == MouseButton4 then return "Mouse4"
  elseif mouseButton == MouseButton5 then return "Mouse5"
  end
  return "Mouse" .. tostring(mouseButton)
end

function onMousePTTKeyDown(self, mousePos, mouseButton)
  if getMouseButtonName(mouseButton) == pttBinding then
    onPTTKeyDown()
    return true
  end
end

function onMousePTTKeyUp(self, mousePos, mouseButton)
  if getMouseButtonName(mouseButton) == pttBinding then
    onPTTKeyUp()
    return true
  end
end

function onPTTKeyDown()
  if not g_game.isOnline() then return end
  pttPressed = true
  print("[VoIP] PTT Key Down - Sending Opcode 201:1 (v2)")
  
  -- Notify Server (for visual indicator)
  local protocol = g_game.getProtocolGame()
  if protocol then
    protocol:sendExtendedOpcode(OPCODE_SPEAKING, "1")
  end
  
  -- Notify Local Helper (to start recording)
  sendToHelper({ type = 'START_TALK' })
  
  local name = g_game.getCharacterName()
  refreshMemberUI(name)
end

function onPTTKeyUp()
  if not g_game.isOnline() then return end
  pttPressed = false
  print("[VoIP] PTT Key Up - Sending Opcode 201:0 (v2)")
  
  -- Notify Server (for visual indicator)
  local protocol = g_game.getProtocolGame()
  if protocol then
    protocol:sendExtendedOpcode(OPCODE_SPEAKING, "0")
  end

  -- Notify Local Helper (to stop recording)
  sendToHelper({ type = 'STOP_TALK' })
  
  local name = g_game.getCharacterName()
  refreshMemberUI(name)
end

function setSensitivity(value)
  sendToHelper({ type = 'SET_SENSITIVITY', value = value })
end

function checkPttState()
  checkPttEvent = scheduleEvent(checkPttState, 100)
  if not pttPressed then return end
  
  if not g_window.hasFocus() then
    print("[VoIP] PTT released due to focus loss")
    onPTTKeyUp()
    return
  end
  
  if pttBinding and pttBinding:find("Mouse") then
    local btn = nil
    if pttBinding == "MouseLeft" then btn = MouseLeftButton
    elseif pttBinding == "MouseRight" then btn = MouseRightButton
    elseif pttBinding == "MouseMiddle" then btn = MouseMiddleButton
    elseif pttBinding == "Mouse4" then btn = MouseButton4
    elseif pttBinding == "Mouse5" then btn = MouseButton5
    end
    
    if btn and not g_mouse.isPressed(btn) then
      print("[VoIP] PTT released due to mouse grab override")
      onPTTKeyUp()
    end
  end
end

-- Helpers
function isLocalLeader()
  local localPlayer = g_game.getLocalPlayer()
  return localPlayer and localPlayer:isPartyLeader()
end

function onMuteClick(widget)
  local id = widget:getId()
  local checked = not widget:isChecked()
  widget:setChecked(checked)

  local vocationPanel = voipWindow:recursiveGetChildById('vocationPanel')
  local controlPanel = voipWindow:recursiveGetChildById('controlPanel')

  if id == "All" then
    -- Mutar todas as vocações e o próprio "All"
    if vocationPanel then
      for _, child in ipairs(vocationPanel:getChildren()) do
        child:setChecked(checked)
        mutedVocations[child:getId()] = checked
      end
    end
    mutedVocations["All"] = checked
  else
    -- Mute individual de vocação
    mutedVocations[id] = checked
    
    -- Verificar se todas as vocações estão mutadas para marcar o "All"
    local allChecked = true
    if vocationPanel then
      for _, child in ipairs(vocationPanel:getChildren()) do
        if not child:isChecked() then
          allChecked = false
          break
        end
      end
    end
    
    if controlPanel then
      local allBtn = controlPanel:getChildById('All')
      if allBtn then allBtn:setChecked(allChecked) end
    end
    mutedVocations["All"] = allChecked
  end

  for name, _ in pairs(partyData) do
    refreshMemberUI(name)
  end
end

function onMemberClick(widget, mousePos, mouseButton)
  if mouseButton == MouseRightButton then
    local name = widget:getId()
    local charName = g_game.getCharacterName()
    
    print("[VoIP] Right click on member: " .. tostring(name) .. " (Self: " .. tostring(charName) .. ")")
    
    if name == charName then 
      print("[VoIP] Ignoring right click on SELF")
      return 
    end

    local data = partyData[name]
    if not data then 
      print("[VoIP] Error: No data for member " .. tostring(name))
      return 
    end

    local menu = g_ui.createWidget('PopupMenu')
    menu:setGameMenu(true)

    local creature = getCreatureByName(name)
    local localPlayer = g_game.getLocalPlayer()

    -- Seguir
    menu:addOption('Seguir', function() 
      if creature then 
        g_game.follow(creature) 
      else
        modules.game_textmessage.displayFailureMessage('Jogador muito longe para seguir.')
      end
    end)

    -- Mandar mensagem
    menu:addOption('Mandar mensagem para ' .. name, function() 
      g_game.openPrivateChannel(name) 
    end)

    -- Adicionar VIP
    if localPlayer and not localPlayer:hasVip(name) then
      menu:addOption('Adicionar a lista VIP', function() 
        g_game.addVip(name) 
      end)
    end

    -- Mute local + Mute global (líder somente)
    if not data.isLeader then
      -- MUTE LOCAL: qualquer membro pode ignorar (líder é protegido, botão aparece desabilitado)
      local isMuted = mutedPlayers[name]
      menu:addOption(isMuted and ('Desfazer ignorar ' .. name) or ('Ignorar ' .. name), function()
        togglePlayerMute(name)
      end)
    end

    if isLocalLeader() and not data.isLeader then
      -- MUTE GLOBAL (só líder): silencia o membro para TODOS no servidor
      menu:addOption('Mutar para todos: ' .. name, function()
        muteGlobalMember(name)
      end)
    end

    -- Passar Liderança
    if localPlayer and localPlayer:isPartyLeader() and not data.isLeader then
      menu:addOption('Passar lideranca para ' .. name, function() 
        if data.id and data.id > 0 then
          g_game.partyPassLeadership(data.id)
        elseif creature then
          g_game.partyPassLeadership(creature:getId())
        else
          modules.game_textmessage.displayFailureMessage('Não foi possível obter o ID do jogador.')
        end
      end)
    end

    menu:addSeparator()

    -- Copiar Nome
    menu:addOption('Copiar Nome', function() 
      g_window.setClipboardText(name) 
    end)

    menu:addSeparator()

    -- REPORT
    menu:addOption('Reportar ' .. name, function() 
      reportMember(name)
    end)
    
    print("[VoIP] Displaying menu for " .. name)
    menu:display(mousePos)
    return true
  end
end

function reportMember(name)
  local data = partyData[name]
  if not data then return end

  local now = os.time()
  if now - lastReportTime < 600 then
    local remaining = math.ceil((600 - (now - lastReportTime)) / 60)
    modules.game_textmessage.displayFailureMessage(tr('Voce deve aguardar ' .. remaining .. ' minutos antes de realizar outro report.'))
    return
  end

  local confirmBox
  confirmBox = displayGeneralBox(tr('Report Player'), tr('Deseja reportar ' .. name .. '? O audio da party (ultimos 60 segundos) sera gravado para analise.\n(Voce podera realizar outro report em 10 minutos)'), {
    { text = tr('Confirmar'), callback = function()
        print("[VoIP] Sending Report for: " .. name .. " (ID: " .. tostring(data.id) .. ")")
        sendToHelper({ 
          type = 'REPORT', 
          targetId = data.id, 
          targetName = name 
        })
        -- Also notify game server if needed
        g_game.getProtocolGame():sendExtendedOpcode(OPCODE_SPEAKING, "REPORT:" .. tostring(data.id))
        
        lastReportTime = os.time()
        modules.game_textmessage.displayStatusMessage(tr('O jogador ' .. name .. ' foi reportado com sucesso.'))
        
        if confirmBox then
          confirmBox:destroy()
          confirmBox = nil
        end
    end },
    { text = tr('Cancelar'), callback = function() 
        if confirmBox then
          confirmBox:destroy() 
          confirmBox = nil
        end
    end }
  })
end

function togglePlayerMute(name)
  local data = partyData[name]
  if not data then return end
  -- Líder nunca pode ser mutado localmente
  if data.isLeader then
    modules.game_textmessage.displayFailureMessage('O líder não pode ser ignorado.')
    return
  end
  mutedPlayers[name] = not mutedPlayers[name]
  -- Notificar o servidor para bloquear/liberar relay deste ID para nós
  sendToHelper({
    type = 'MUTE_MEMBER',
    targetId = data.id,
    targetName = name,
    muted = mutedPlayers[name]
  })
  refreshMemberUI(name)
end

function muteGlobalMember(name)
  -- Apenas o líder pode usar esta função (validado no servidor também)
  if not isLocalLeader() then
    modules.game_textmessage.displayFailureMessage('Apenas o líder pode mutar para todos.')
    return
  end
  -- Mute global: ativa sala em modo silencioso (só líder fala)
  local currentState = isGlobalMuted
  sendToHelper({
    type = 'GLOBAL_MUTE',
    muted = not currentState
  })
  -- O estado real será atualizado quando o servidor enviar global_mute_changed
  local msg = (not currentState) and 'Mute global ativado. Apenas você será ouvido.' or 'Mute global desativado.'
  modules.game_textmessage.displayStatusMessage(msg)
end

function getDevices()
  sendToHelper({ type = 'LIST_DEVICES' })
end

function setDevice(deviceId)
  sendToHelper({ type = 'SET_DEVICE', deviceId = deviceId })
end

function getDevicesOut()
  sendToHelper({ type = 'LIST_DEVICES_OUT' })
end

function setDeviceOut(deviceId)
  sendToHelper({ type = 'SET_DEVICE_OUT', deviceId = deviceId })
end

function startTest()
  sendToHelper({ type = 'TEST_START' })
end

function stopTest()
  sendToHelper({ type = 'TEST_STOP' })
end
