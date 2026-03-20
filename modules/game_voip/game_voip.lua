voipWindow = nil
voipButton = nil
refreshEvent = nil

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

function init()
  voipButton = modules.client_topmenu.addRightGameToggleButton(
    'voipButton', tr('Party VoIP'), '/images/topbuttons/audio', toggle
  )
  voipButton:setOn(false)

  voipWindow = g_ui.loadUI('game_voip', modules.game_interface.getRightPanel())
  voipWindow:setup()
  voipWindow:close()

  -- Ouve mudanças de Shield (junta/sai de party) em qualquer criatura
  connect(Creature, { onShieldChange = onShieldChange })
  connect(g_game,   { onGameEnd = clearMembers })
end

function terminate()
  disconnect(Creature, { onShieldChange = onShieldChange })
  disconnect(g_game,   { onGameEnd = clearMembers })
  if refreshEvent then
    removeEvent(refreshEvent)
    refreshEvent = nil
  end
  voipButton:destroy()
  voipWindow:destroy()
end

function toggle()
  if voipButton:isOn() then
    voipWindow:close()
    voipButton:setOn(false)
  else
    voipWindow:open()
    voipButton:setOn(true)
    refreshPartyList()
  end
end

function onMiniWindowClose()
  voipButton:setOn(false)
end

-- Chamado quando qualquer criatura tem o escudo alterado (event de party)
function onShieldChange(creature, shield, blink)
  -- Debounce: espera 300ms antes de atualizar para evitar múltiplos refreshes
  if refreshEvent then
    removeEvent(refreshEvent)
  end
  refreshEvent = scheduleEvent(refreshPartyList, 300)
end

function clearMembers()
  if not voipWindow then return end
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if memberList then
    memberList:destroyChildren()
  end
  local label = voipWindow:recursiveGetChildById('descriptionLabel')
  if label then
    label:setText(tr('No active call.'))
    label:show()
  end
end

function refreshPartyList()
  refreshEvent = nil
  if not voipWindow then return end

  clearMembers()

  local localPlayer = g_game.getLocalPlayer()
  if not localPlayer then return end

  -- Verifica se o jogador local está em uma party
  if not localPlayer:isPartyMember() then return end

  local creatures = g_map.getSpectators(localPlayer:getPosition(), false)
  local leader = nil
  local members = {}

  for _, creature in ipairs(creatures) do
    if creature:isPlayer() then
      if creature:isPartyLeader() then
        leader = creature
      elseif creature:isPartyMember() then
        table.insert(members, creature)
      end
    end
  end

  -- Se o jogador local é o líder
  if localPlayer:isPartyLeader() then
    leader = localPlayer
  end

  -- Nenhum membro de party visível ainda
  if not leader and #members == 0 then return end

  -- Esconde o label "No active call"
  local label = voipWindow:recursiveGetChildById('descriptionLabel')
  if label then label:hide() end

  -- Adiciona líder primeiro
  if leader then
    local vocName = VOCATION_NAMES[leader:getVocation()] or "Unknown"
    addMember("👑 " .. leader:getName(), vocName, true)
  end

  -- Adiciona o próprio player local se for apenas membro (não líder)
  if localPlayer:isPartyMember() and not localPlayer:isPartyLeader() then
    local vocName = VOCATION_NAMES[localPlayer:getVocation()] or "Unknown"
    addMember(localPlayer:getName(), vocName, false)
  end

  -- Adiciona os outros membros visíveis
  for _, member in ipairs(members) do
    if member:getId() ~= localPlayer:getId() then
      local vocName = VOCATION_NAMES[member:getVocation()] or "Unknown"
      addMember(member:getName(), vocName, false)
    end
  end
end

function addMember(name, vocation, isLeader)
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  if not memberList then return end
  local widget = g_ui.createWidget('VoipMember', memberList)
  widget:getChildById('name'):setText(name)
  widget:getChildById('vocation'):setText(vocation)
  if isLeader then
    widget:getChildById('name'):setColor('#FFD700')
  end
end
