on run
    set ctl to (POSIX path of (path to home folder)) & "Library/Application Support/pi-web-launcher/pi-webctl"
    try
        try
            set currentStatus to do shell script (quoted form of ctl) & " status"
        on error statusMessage
            set currentStatus to statusMessage
        end try
        activate
        set choice to button returned of (display dialog currentStatus with title "Pi Web" buttons {"取消", "登录自启设置", "打开网页"} default button "打开网页" cancel button "取消")
        if choice is "登录自启设置" then
            set choice to button returned of (display dialog currentStatus & return & return & "登录自启只启动后台服务，不打开网页。开关不会启停当前服务。" with title "Pi Web 登录自启" buttons {"关闭自启", "取消", "开启自启"} default button "取消" cancel button "取消")
        end if
        set resultText to my performAction(choice, ctl)
        if choice is not "打开网页" then display dialog resultText with title "Pi Web 登录自启" buttons {"好"} default button "好"
    on error errorMessage number errorNumber
        if errorNumber is not -128 then
            activate
            display alert "Pi Web 操作失败" message errorMessage as critical
        end if
    end try
end run

on reopen
    activate
end reopen

on performAction(choice, ctl)
    if choice is "打开网页" then
        set arguments to " open"
    else if choice is "开启自启" then
        set arguments to " autostart on"
    else if choice is "关闭自启" then
        set arguments to " autostart off"
    else
        error "未知操作"
    end if
    return do shell script (quoted form of ctl) & arguments
end performAction
