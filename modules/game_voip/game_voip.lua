voipWindow = nil
voipButton = nil
voipUpdateEvent = nil

local OPCODE_VOIP = 200
local OPCODE_SPEAKING = 201

local VOCATION_NAMES = {
  [0] = "None",
  [1] = "Sorcerer",
  [2] = "Druid",
  [3] = "Paladin",
  [4] = "Knight",
  [5] = "Master Sorcerer",
  [6] = "Elder Druid",
  [7] = "Royal Paladin",
  [8] = "Elite Knight",
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
local partyData = {}  -- {name -> {vocID, isLeader}}
local mutedVocations = {}
local mutedPlayers = {}
local pttBinding = nil
local pttPressed = false
local checkPttEvent = nil

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
  voipButton = modules.client_topmenu.addRightGameToggleButton(
    'voipButton', tr('Party VoIP'), '/data/images/topbuttons/audio', toggle
  )
  voipButton:setOn(false)

  voipWindow = g_ui.loadUI('game_voip', modules.game_interface.getRightPanel())
  voipWindow:setup()
  voipWindow:close()

  ProtocolGame.registerExtendedOpcode(OPCODE_VOIP, onVoipUpdate)
  ProtocolGame.registerOpcode(0xE0, onVoipSession)
  ProtocolGame.registerOpcode(0xE1, onVoipClose)
  connect(g_game, { onGameStart = onGameStart, onGameEnd = clearMembers })
  
  if checkPttEvent then removeEvent(checkPttEvent) end
  checkPttEvent = scheduleEvent(checkPttState, 100)
  
  -- Check for PTT binding every second or on session join
  scheduleEvent(updatePttBinding, 1000)
end

function terminate()
  removeEvent(voipUpdateEvent)
  ProtocolGame.unregisterExtendedOpcode(OPCODE_VOIP)
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

      local vocName = VOCATION_NAMES[vocID] or "None"
      local outfit = {
        type   = tonumber(outfitparts[1]) or 0,
        head   = tonumber(outfitparts[2]) or 0,
        body   = tonumber(outfitparts[3]) or 0,
        legs   = tonumber(outfitparts[4]) or 0,
        feet   = tonumber(outfitparts[5]) or 0,
        addons = tonumber(outfitparts[6]) or 0,
      }

      partyData[name] = { id = id, vocID = vocID, outfit = outfit, isLeader = isLeader, isSpeaking = isSpeaking }
      
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
    
    local vocName = VOCATION_NAMES[member.vocation] or "None"
    
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
end

function onVoipClose(protocol, msg)
  local roomId = msg:getString()
  voipWindow:close()
  voipButton:setOn(false)
  clearMembers()
end

function clearMembers()
  partyData = {}
  removeEvent(voipUpdateEvent)
  voipUpdateEvent = nil
  if not voipWindow then return end
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if memberList then memberList:destroyChildren() end
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
    widget:setId(name)
  end

  local displayName = isLeader and (name .. " (L)") or name
  widget:getChildById('name'):setText(displayName)
  widget:getChildById('name'):setColor(isLeader and '#FFD700' or '#FFFFFF')
  widget:getChildById('vocation'):setText(vocation)
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
  local isMuted = mutedVocations["All"] or mutedVocations[vocMuteId] or mutedPlayers[name]
  local indicator = widget:getChildById('voiceIndicator')

  if isMuted then
    indicator:setImageColor('#ff0000') -- Red for Muted
    indicator:setVisible(true)
  else
    -- Use the isSpeaking state from partyData (synced from server)
    local isSpeaking = data.isSpeaking
    if name == g_game.getCharacterName() then
      isSpeaking = pttPressed
    end
    
    indicator:setImageColor('#00ff00') -- Green for Speaking
    indicator:setVisible(isSpeaking)
  end
end

function updatePttBinding()
  if not modules.game_hotkeys then return end
  local hotkey = modules.game_hotkeys.getPttHotkey()
  if hotkey == pttBinding then 
    scheduleEvent(updatePttBinding, 2000)
    return 
  end

  local root = modules.game_interface.getRootPanel()
  if pttBinding then
    g_keyboard.unbindKeyDown(pttBinding)
    g_keyboard.unbindKeyUp(pttBinding)
    disconnect(root, { onMousePress = onMousePTTKeyDown, onMouseRelease = onMousePTTKeyUp })
  end

  pttBinding = hotkey
  if pttBinding and pttBinding ~= "" then
    print("[VoIP] Binding PTT to: " .. pttBinding)
    if pttBinding:find("Mouse") then
      connect(root, { onMousePress = onMousePTTKeyDown, onMouseRelease = onMousePTTKeyUp })
    else
      g_keyboard.bindKeyDown(pttBinding, onPTTKeyDown)
      g_keyboard.bindKeyUp(pttBinding, onPTTKeyUp)
    end
  end
  
  scheduleEvent(updatePttBinding, 2000)
end

function getMouseButtonName(mouseButton)
  if mouseButton == MouseLeftButton then return "MouseLeft"
  elseif mouseButton == MouseRightButton then return "MouseRight"
  elseif mouseButton == MouseMiddleButton then return "MouseMiddle"
  elseif mouseButton == MouseButton4 then return "Mouse4"
  elseif mouseButton == MouseButton5 then return "Mouse5"
  end
  return ""
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
  if pttPressed then return end
  
  pttPressed = true
  print("[VoIP] PTT Key Down - Sending Opcode 201:1 (v2)")
  local protocol = g_game.getProtocolGame()
  if protocol then
    protocol:sendExtendedOpcode(OPCODE_SPEAKING, "1")
  else
    print("[VoIP] Error: No protocol to send opcode 201")
  end
  
  local name = g_game.getCharacterName()
  refreshMemberUI(name)
end

function onPTTKeyUp()
  if not g_game.isOnline() then return end
  if not pttPressed then return end
  
  pttPressed = false
  print("[VoIP] PTT Key Up - Sending Opcode 201:0 (v2)")
  local protocol = g_game.getProtocolGame()
  if protocol then
    protocol:sendExtendedOpcode(OPCODE_SPEAKING, "0")
  else
    print("[VoIP] Error: No protocol to send opcode 201")
  end
  
  local name = g_game.getCharacterName()
  refreshMemberUI(name)
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

function onMuteClick(widget)
  local id = widget:getId()
  local checked = not widget:isChecked()
  widget:setChecked(checked)

  if id == "All" then
    local header = voipWindow:recursiveGetChildById('muteHeader')
    for _, child in ipairs(header:getChildren()) do
      child:setChecked(checked)
      mutedVocations[child:getId()] = checked
    end
  else
    mutedVocations[id] = checked
    -- Check if all individual buttons are checked -> auto-check All
    local header = voipWindow:recursiveGetChildById('muteHeader')
    local allChecked = true
    for _, child in ipairs(header:getChildren()) do
      if child:getId() ~= "All" and not child:isChecked() then
        allChecked = false
        break
      end
    end
    local allBtn = header:getChildById('All')
    if allBtn then allBtn:setChecked(allChecked) end
    mutedVocations["All"] = allChecked
  end

  -- Refresh all member widgets
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

    -- Ignorar (VoIP Mute)
    local isMuted = mutedPlayers[name]
    menu:addOption(isMuted and ('Designorar ' .. name) or ('Ignorar ' .. name), function() 
      togglePlayerMute(name)
    end)

    -- Passar Lideranca
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
    
    print("[VoIP] Displaying menu for " .. name)
    menu:display(mousePos)
    return true
  end
end

function togglePlayerMute(name)
  mutedPlayers[name] = not mutedPlayers[name]
  refreshMemberUI(name)
end
