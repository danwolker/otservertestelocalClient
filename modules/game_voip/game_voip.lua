voipWindow = nil
voipButton = nil
voipUpdateEvent = nil

local OPCODE_VOIP = 200

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
local partyData = {}  -- {name -> {vocation, outfit, isLeader}}
local mutedVocations = {}

local function split(text, sep)
  local res = {}
  for str in string.gmatch(text, "([^"..sep.."]+)") do
    table.insert(res, str)
  end
  return res
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
  connect(g_game, { onGameEnd = clearMembers })
end

function terminate()
  removeEvent(voipUpdateEvent)
  ProtocolGame.unregisterExtendedOpcode(OPCODE_VOIP)
  disconnect(g_game, { onGameEnd = clearMembers })
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
      -- Try to find the creature in the local game state
      local creature = g_map.getCreatureByName(name)
      if creature then
        local hp = creature:getHealthPercent()
        widget:getChildById('healthBar'):setValue(hp, 0, 100)
        -- UICreature auto-renders the outfit, just ensure it's set once
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
      local hpPercent = tonumber(parts[4]) or 0
      local mpPercent = tonumber(parts[5]) or 0
      local isLeader = (i == 1)

      local vocName = VOCATION_NAMES[vocID] or "None"
      local outfit = {
        type   = tonumber(outfitparts[1]) or 0,
        head   = tonumber(outfitparts[2]) or 0,
        body   = tonumber(outfitparts[3]) or 0,
        legs   = tonumber(outfitparts[4]) or 0,
        feet   = tonumber(outfitparts[5]) or 0,
        addons = tonumber(outfitparts[6]) or 0,
      }

      partyData[name] = { vocID = vocID, outfit = outfit, isLeader = isLeader }
      addMember(name, vocName, isLeader, outfit, hpPercent, mpPercent)
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
  widget:getChildById('creature'):setOutfit(outfit)
  widget:getChildById('healthBar'):setValue(healthPercent, 0, 100)
  widget:getChildById('manaBar'):setValue(manaPercent, 0, 100)
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
  end
end
