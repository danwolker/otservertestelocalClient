local defaultOptions = {
  layout = DEFAULT_LAYOUT, -- set in init.lua
  vsync = true,
  showFps = true,
  showPing = true,
  fullscreen = false,
  classicView = not g_app.isMobile(),
  cacheMap = g_app.isMobile(),
  classicControl = not g_app.isMobile(),
  smartWalk = false,
  dash = false,
  autoChaseOverride = true,
  showStatusMessagesInConsole = true,
  showEventMessagesInConsole = true,
  showInfoMessagesInConsole = true,
  showTimestampsInConsole = true,
  showLevelsInConsole = true,
  showPrivateMessagesInConsole = true,
  showPrivateMessagesOnScreen = true,
  rightPanels = 1,
  leftPanels = g_app.isMobile() and 1 or 2,
  containerPanel = 8,
  backgroundFrameRate = 60,
  enableAudio = true,
  enableMusicSound = false,
  musicSoundVolume = 100,
  botSoundVolume = 100,
  enableLights = false,
  floorFading = 500,
  crosshair = 2,
  ambientLight = 100,
  optimizationLevel = 1,
  displayNames = true,
  displayHealth = true,
  displayMana = true,
  displayHealthOnTop = false,
  showHealthManaCircle = false,
  hidePlayerBars = false,
  highlightThingsUnderCursor = true,
  topHealtManaBar = true,
  displayText = true,
  dontStretchShrink = false,
  turnDelay = 30,
  hotkeyDelay = 30,
    
  wsadWalking = false,
  walkFirstStepDelay = 200,
  walkTurnDelay = 100,
  walkStairsDelay = 50,
  walkTeleportDelay = 200,
  walkCtrlTurnDelay = 150,

  topBar = true,

  actionbar1 = true,
  actionbar2 = false,
  actionbar3 = false,
  actionbar4 = false,
  actionbar5 = false,
  actionbar6 = false,
  actionbar7 = false,
  actionbar8 = false,
  actionbar9 = false,

  actionbarLock = false,

  profile = 1,
  
  antialiasing = true,
  autoExit = false,
  micSensitivity = 10,
  speakerVolume = 100,
  inputProfile = 'studio'
}

local optionsWindow
local optionsButton
local optionsTabBar
local options = {}
local extraOptions = {}
local generalPanel
local interfacePanel
local consolePanel
local graphicsPanel
local audioPanel
local customPanel
local extrasPanel
local audioButton
local isTestingAudio = false


function init()
  for k,v in pairs(defaultOptions) do
    g_settings.setDefault(k, v)
    options[k] = v
  end
  for _, v in ipairs(g_extras.getAll()) do
	  extraOptions[v] = g_extras.get(v)
    g_settings.setDefault("extras_" .. v, extraOptions[v])
  end

  optionsWindow = g_ui.displayUI('options')
  optionsWindow:hide()

  optionsTabBar = optionsWindow:getChildById('optionsTabBar')
  optionsTabBar:setContentWidget(optionsWindow:recursiveGetChildById('optionsScrollArea'))

  g_keyboard.bindKeyDown('Ctrl+Shift+F', function() toggleOption('fullscreen') end)
  g_keyboard.bindKeyDown('Ctrl+N', toggleDisplays)

  generalPanel = g_ui.loadUI('game')
  optionsTabBar:addTab(tr('Game'), generalPanel, '/images/optionstab/game')
  
  interfacePanel = g_ui.loadUI('interface')
  optionsTabBar:addTab(tr('Interface'), interfacePanel, '/images/optionstab/game')  

  consolePanel = g_ui.loadUI('console')
  optionsTabBar:addTab(tr('Console'), consolePanel, '/images/optionstab/console')

  graphicsPanel = g_ui.loadUI('graphics')
  optionsTabBar:addTab(tr('Graphics'), graphicsPanel, '/images/optionstab/graphics')

  audioPanel = g_ui.loadUI('audio')
  optionsTabBar:addTab(tr('Audio'), audioPanel, '/images/optionstab/audio')
  
  local profileCombo = audioPanel:getChildById('inputProfile')
  if profileCombo then
    profileCombo:addOption(tr('Estudio (Audio Puro)'), 'studio')
    profileCombo:addOption(tr('Isolamento de Voz'), 'isolation')
  end


  extrasPanel = g_ui.createWidget('OptionPanel')
  for _, v in ipairs(g_extras.getAll()) do
    local extrasButton = g_ui.createWidget('OptionCheckBox')
    extrasButton:setId(v)
    extrasButton:setText(g_extras.getDescription(v))
    extrasPanel:addChild(extrasButton)
  end
  if not g_game.getFeature(GameNoDebug) and not g_app.isMobile() then
    optionsTabBar:addTab(tr('Extras'), extrasPanel, '/images/optionstab/extras')
  end

  customPanel = g_ui.loadUI('custom')
  optionsTabBar:addTab(tr('Custom'), customPanel, '/images/optionstab/features')

  optionsTabBar.onTabChange = function(tabBar, tab)
    local panel = tab.tabPanel
    if tab:getText() == tr('Audio') then
      panel:setHeight(520)
      panel:removeAnchor(AnchorBottom)
    end
    -- Garantir que a área de rolagem perceba a mudança de tamanho do filho
    local scrollArea = optionsWindow:recursiveGetChildById('optionsScrollArea')
    if scrollArea then
       addEvent(function() scrollArea:updateScrollBars() end)
    end
  end

  optionsButton = modules.client_topmenu.addLeftButton('optionsButton', tr('Options'), '/images/topbuttons/options', toggle)
  audioButton = modules.client_topmenu.addLeftButton('audioButton', tr('Audio'), '/images/topbuttons/audio', function() toggleOption('enableAudio') end)
  if g_app.isMobile() then
    audioButton:hide()
  end
  
  addEvent(function() setup() end)
  
  connect(g_game, { onGameStart = online,
                     onGameEnd = offline })                    
end

function terminate()
  disconnect(g_game, { onGameStart = online,
                     onGameEnd = offline })  

  g_keyboard.unbindKeyDown('Ctrl+Shift+F')
  g_keyboard.unbindKeyDown('Ctrl+N')
  if isTestingAudio then
    print(">> [VoIP] Terminate: Stopping active audio test.")
    testAudio()
  end
  optionsWindow:destroy()
  optionsButton:destroy()
  audioButton:destroy()
end

function setup()
  -- load options
  for k,v in pairs(defaultOptions) do
    if type(v) == 'boolean' then
      setOption(k, g_settings.getBoolean(k), true)
    elseif type(v) == 'number' then
      setOption(k, g_settings.getNumber(k), true)
    elseif type(v) == 'string' then
      setOption(k, g_settings.getString(k), true)
    end
  end
  
  for _, v in ipairs(g_extras.getAll()) do
    g_extras.set(v, g_settings.getBoolean("extras_" .. v))
    local widget = extrasPanel:recursiveGetChildById(v)
    if widget then
      widget:setChecked(g_extras.get(v))
    end
  end  
  
  if g_game.isOnline() then
    online()
  end  
end

function toggle()
  if optionsWindow:isVisible() then
    hide()
  else
    show()
  end
end

function show()
  optionsWindow:show()
  optionsWindow:raise()
  optionsWindow:focus()
  
  if modules.game_voip then
    modules.game_voip.getDevices()
    modules.game_voip.getDevicesOut()
  end
end

function hide()
  if isTestingAudio then
    print(">> [VoIP] Hide: Stopping active audio test.")
    testAudio()
  end
  optionsWindow:hide()
end

function toggleDisplays()
  if options['displayNames'] and options['displayHealth'] and options['displayMana'] then
    setOption('displayNames', false)
  elseif options['displayHealth'] then
    setOption('displayHealth', false)
    setOption('displayMana', false)
  else
    if not options['displayNames'] and not options['displayHealth'] then
      setOption('displayNames', true)
    else
      setOption('displayHealth', true)
      setOption('displayMana', true)
    end
  end
end

function toggleOption(key) 
  setOption(key, not getOption(key))
end

function setOption(key, value, force)
  if extraOptions[key] ~= nil then
    g_extras.set(key, value)
    g_settings.set("extras_" .. key, value)
    if key == "debugProxy" and modules.game_proxy then
      if value then
        modules.game_proxy.show()
      else
        modules.game_proxy.hide()      
      end
    end
    return
  end
  
  if modules.game_interface == nil then
    return
  end
   
  if not force and options[key] == value then return end
  local gameMapPanel = modules.game_interface.getMapPanel()

  if key == 'vsync' then
    g_window.setVerticalSync(value)
  elseif key == 'showFps' then
    modules.client_topmenu.setFpsVisible(value)
    if modules.game_stats and modules.game_stats.ui.fps then
      modules.game_stats.ui.fps:setVisible(value)
    end
  elseif key == 'showPing' then
    modules.client_topmenu.setPingVisible(value)
    if modules.game_stats and modules.game_stats.ui.ping then
      modules.game_stats.ui.ping:setVisible(value)
    end
  elseif key == 'fullscreen' then
    g_window.setFullscreen(value)
  elseif key == 'enableAudio' then
    if g_sounds ~= nil then
      g_sounds.setAudioEnabled(value)
    end
    if value then
      audioButton:setIcon('/images/topbuttons/audio')
    else
      audioButton:setIcon('/images/topbuttons/audio_mute')
    end
  elseif key == 'enableMusicSound' then
    if g_sounds ~= nil then
      g_sounds.getChannel(SoundChannels.Music):setEnabled(value)
    end
  elseif key == 'musicSoundVolume' then
    if g_sounds ~= nil then
      g_sounds.getChannel(SoundChannels.Music):setGain(value/100)
    end
    audioPanel:getChildById('musicSoundVolumeLabel'):setText(tr('Music volume: %d', value))
  elseif key == 'botSoundVolume' then
    if g_sounds ~= nil then
      g_sounds.getChannel(SoundChannels.Bot):setGain(value/100)
    end
    audioPanel:getChildById('botSoundVolumeLabel'):setText(tr('Bot sound volume: %d', value))    
  elseif key == 'showHealthManaCircle' then
    modules.game_healthinfo.healthCircle:setVisible(value)
    modules.game_healthinfo.healthCircleFront:setVisible(value)
    modules.game_healthinfo.manaCircle:setVisible(value)
    modules.game_healthinfo.manaCircleFront:setVisible(value)
  elseif key == 'backgroundFrameRate' then
    local text, v = value, value
    if value <= 0 or value >= 201 then text = 'max' v = 0 end
    graphicsPanel:getChildById('backgroundFrameRateLabel'):setText(tr('Game framerate limit: %s', text))
    g_app.setMaxFps(v)
  elseif key == 'enableLights' then
    gameMapPanel:setDrawLights(value and options['ambientLight'] < 100)
    graphicsPanel:getChildById('ambientLight'):setEnabled(value)
    graphicsPanel:getChildById('ambientLightLabel'):setEnabled(value)
  elseif key == 'floorFading' then
    gameMapPanel:setFloorFading(value)
    interfacePanel:getChildById('floorFadingLabel'):setText(tr('Floor fading: %s ms', value))
  elseif key == 'crosshair' then
    if value == 1 then
      gameMapPanel:setCrosshair("")    
    elseif value == 2 then
      gameMapPanel:setCrosshair("/images/crosshair/default.png")        
    elseif value == 3 then
      gameMapPanel:setCrosshair("/images/crosshair/full.png")    
    end
  elseif key == 'ambientLight' then
    graphicsPanel:getChildById('ambientLightLabel'):setText(tr('Ambient light: %s%%', value))
    gameMapPanel:setMinimumAmbientLight(value/100)
    gameMapPanel:setDrawLights(options['enableLights'] and value < 100)
  elseif key == 'optimizationLevel' then
    g_adaptiveRenderer.setLevel(value - 2)
  elseif key == 'displayNames' then
    gameMapPanel:setDrawNames(value)
  elseif key == 'displayHealth' then
    gameMapPanel:setDrawHealthBars(value)
  elseif key == 'displayMana' then
    gameMapPanel:setDrawManaBar(value)
  elseif key == 'displayHealthOnTop' then
    gameMapPanel:setDrawHealthBarsOnTop(value)
  elseif key == 'hidePlayerBars' then
    gameMapPanel:setDrawPlayerBars(value)
  elseif key == 'topHealtManaBar' then
    modules.game_healthinfo.topHealthBar:setVisible(value)
    modules.game_healthinfo.topManaBar:setVisible(value)
  elseif key == 'displayText' then
    gameMapPanel:setDrawTexts(value)
  elseif key == 'dontStretchShrink' then
    addEvent(function()
      modules.game_interface.updateStretchShrink()
    end)
  elseif key == 'dash' then
    if value then
      g_game.setMaxPreWalkingSteps(2)
    else 
      g_game.setMaxPreWalkingSteps(1)    
    end
  elseif key == 'wsadWalking' then
    if modules.game_console and modules.game_console.consoleToggleChat:isChecked() ~= value then
      modules.game_console.consoleToggleChat:setChecked(value)
    end
  elseif key == 'hotkeyDelay' then
    generalPanel:getChildById('hotkeyDelayLabel'):setText(tr('Hotkey delay: %s ms', value))  
  elseif key == 'walkFirstStepDelay' then
    generalPanel:getChildById('walkFirstStepDelayLabel'):setText(tr('Walk delay after first step: %s ms', value))  
  elseif key == 'walkTurnDelay' then
    generalPanel:getChildById('walkTurnDelayLabel'):setText(tr('Walk delay after turn: %s ms', value))  
  elseif key == 'walkStairsDelay' then
    generalPanel:getChildById('walkStairsDelayLabel'):setText(tr('Walk delay after floor change: %s ms', value))  
  elseif key == 'walkTeleportDelay' then
    generalPanel:getChildById('walkTeleportDelayLabel'):setText(tr('Walk delay after teleport: %s ms', value))  
  elseif key == 'walkCtrlTurnDelay' then
    generalPanel:getChildById('walkCtrlTurnDelayLabel'):setText(tr('Walk delay after ctrl turn: %s ms', value))  
  elseif key == "antialiasing" then
    g_app.setSmooth(value)
  elseif key == "micSensitivity" then
    audioPanel:getChildById('micSensitivityLabel'):setText(tr('Mic Sensitivity: %d%%', value))
    if modules.game_voip then
      modules.game_voip.setSensitivity(value)
    end
  elseif key == 'speakerVolume' then
    audioPanel:getChildById('speakerVolumeLabel'):setText(tr('Speaker Volume: %d%%', value))
    if modules.game_voip then modules.game_voip.setSpeakerVolume(value) end
  elseif key == 'inputProfile' then
    if modules.game_voip then modules.game_voip.setInputProfile(value) end
  end

  -- change value for keybind updates
  for _,panel in pairs(optionsTabBar:getTabsPanel()) do
    local widget = panel:recursiveGetChildById(key)
    if widget then
      if widget:getStyle().__class == 'UICheckBox' then
        widget:setChecked(value)
      elseif widget:getStyle().__class == 'UIScrollBar' then
        widget:setValue(value)
      elseif widget:getStyle().__class == 'UIComboBox' then
        if type(value) == "string" then
          widget:setCurrentOption(value, true)
          break
        end
        if value == nil or value < 1 then 
          value = 1
        end
        if widget.currentIndex ~= value then
          widget:setCurrentIndex(value, true)
        end
      end      
      break
    end
  end
  
  g_settings.set(key, value)
  options[key] = value

  if key == "profile" then
    modules.client_profiles.onProfileChange()
  end
  
  if key == 'classicView' or key == 'rightPanels' or key == 'leftPanels' or key == 'cacheMap' then
    modules.game_interface.refreshViewMode()    
  elseif key:find("actionbar") then
    modules.game_actionbar.show()
  end

  if key == 'topBar' then
    modules.game_topbar.show()
  end
end

function getOption(key)
  return options[key]
end

function addTab(name, panel, icon)
  optionsTabBar:addTab(name, panel, icon)
end

function addButton(name, func, icon)
  optionsTabBar:addButton(name, func, icon)
end

-- hide/show

function online()
  setLightOptionsVisibility(not g_game.getFeature(GameForceLight))
  g_app.setSmooth(g_settings.getBoolean("antialiasing"))
end

function offline()
  setLightOptionsVisibility(true)
end

-- classic view

-- graphics
function setLightOptionsVisibility(value)
  graphicsPanel:getChildById('enableLights'):setEnabled(value)
  graphicsPanel:getChildById('ambientLightLabel'):setEnabled(value)
  graphicsPanel:getChildById('ambientLight'):setEnabled(value)  
  interfacePanel:getChildById('floorFading'):setEnabled(value)
  interfacePanel:getChildById('floorFadingLabel'):setEnabled(value)
  interfacePanel:getChildById('floorFadingLabel2'):setEnabled(value)  
end

function updateDeviceList(devices)
  print(">> [VoIP] Options: updateDeviceList called with " .. #devices .. " devices")
  if not audioPanel then 
    print(">> [VoIP] Options: Error - audioPanel is nil")
    return 
  end
  local microphoneCombo = audioPanel:getChildById('microphone')
  if not microphoneCombo then 
    print(">> [VoIP] Options: Error - microphone ComboBox not found")
    return 
  end

  local currentText = microphoneCombo:getText()
  microphoneCombo:clearOptions()
  for _, device in ipairs(devices) do
    microphoneCombo:addOption(device.name, device.id)
  end
  
  if currentText ~= "" then
    microphoneCombo:setCurrentOption(currentText, true)
  end
end

function setMicrophone(name, deviceId)
  if modules.game_voip then
    modules.game_voip.setDevice(deviceId)
  end
end

function updateSpeakerList(devices)
  if not audioPanel then return end
  local speakerCombo = audioPanel:getChildById('speaker')
  if not speakerCombo then return end

  local currentText = speakerCombo:getText()
  speakerCombo:clearOptions()
  for _, device in ipairs(devices) do
    speakerCombo:addOption(device.name, device.id)
  end
  
  if currentText ~= "" then
    speakerCombo:setCurrentOption(currentText, true)
  end
end

function setSpeaker(name, deviceId)
  if modules.game_voip then
    modules.game_voip.setDeviceOut(deviceId)
  end
end

function testAudio()
  if not modules.game_voip or not audioPanel then return end
  
  local testSection = audioPanel:getChildById('testSection')
  if not testSection then return end

  local testButton = testSection:getChildById('testAudio')
  local voiceActivity = testSection:getChildById('voiceActivity')
  if not testButton or not voiceActivity then return end

  isTestingAudio = not isTestingAudio
  
  if isTestingAudio then
    testButton:setText(tr('Stop Test'))
    voiceActivity:setVisible(true)
    modules.game_voip.startTest()
  else
    testButton:setText(tr('Test Microphone'))
    voiceActivity:setVisible(false)
    voiceActivity:setValue(0, 0, 100)
    modules.game_voip.stopTest()
  end
end

function updateVoiceActivity(level)
  if not audioPanel or not isTestingAudio then return end
  local testSection = audioPanel:getChildById('testSection')
  if not testSection then return end
  
  local voiceActivity = testSection:getChildById('voiceActivity')
  if voiceActivity then
    voiceActivity:setValue(level, 0, 100)
    
    local r, g = 0, 255
    if level < 50 then
      r = 255
      g = math.floor(255 * (level / 50))
    else
      r = math.floor(255 * (1 - (level - 50) / 50))
      g = 255
    end
    
    local color = string.format("#%02X%02X00", r, g)
    voiceActivity:setImageColor(color)
    
    local sensitivity = options['micSensitivity'] or 10
    if level < sensitivity then
      voiceActivity:setOpacity(0.5) -- Dimmer when below gate
    else
      voiceActivity:setOpacity(1.0)
    end
  end
end
