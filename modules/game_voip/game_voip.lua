voipWindow = nil
voipButton = nil

function init()
  print("VoIP module: Initializing...")
  voipButton = modules.client_topmenu.addRightGameToggleButton('voipButton', tr('Party VoIP'), '/images/topbuttons/audio', toggle)
  voipButton:setOn(false)

  voipWindow = g_ui.loadUI('game_voip', modules.game_interface.getRightPanel())
  voipWindow:setup()
  voipWindow:close()

  -- Visual Test: Add sample members
  addMember("👑 LeaderName", "Elite Knight", true)
  addMember("Member 2", "Royal Paladin", false)
  addMember("Member 3", "Master Sorcerer", false)
end

function addMember(name, vocation, isLeader)
  local memberList = voipWindow:recursiveGetChildById('voipMemberList')
  local widget = g_ui.createWidget('VoipMember', memberList)
  widget:getChildById('name'):setText(name)
  widget:getChildById('vocation'):setText(vocation)
  if isLeader then
    widget:getChildById('name'):setColor('#FFD700') -- Gold for leader
  end
end

function terminate()
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
  end
end

function onMiniWindowClose()
  voipButton:setOn(false)
end
