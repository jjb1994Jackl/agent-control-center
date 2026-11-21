import ApplicationServices
import Darwin
import Foundation

let flags = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-psn_") }
if flags.isEmpty, let file = Bundle.main.object(forInfoDictionaryKey: "ACCLauncherFile") as? String {
    let launcher = Process()
    launcher.executableURL = URL(fileURLWithPath: file)
    launcher.arguments = ["launch"]
    do { try launcher.run(); launcher.waitUntilExit(); exit(launcher.terminationStatus) }
    catch { exit(1) }
}
if flags.isEmpty || flags == ["--request-accessibility"] {
    let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    print(trusted ? "accessibility: granted" : "accessibility: awaiting user")
    if !trusted { RunLoop.current.run(until: Date(timeIntervalSinceNow: 2)) }
    exit(trusted ? 0 : 77)
}
if flags == ["--check-accessibility"] {
    let trusted = AXIsProcessTrusted()
    print(trusted ? "accessibility: granted" : "accessibility: not granted")
    exit(trusted ? 0 : 77)
}

guard flags.count == 3, flags.first == "--serve" else { exit(64) }
let child = Process()
child.executableURL = URL(fileURLWithPath: flags[1])
child.arguments = [flags[2]]
child.standardOutput = FileHandle.standardOutput
child.standardError = FileHandle.standardError

do { try child.run() }
catch {
    FileHandle.standardError.write(Data("Agent Control Center: \(error.localizedDescription)\n".utf8))
    exit(1)
}
// Keep this dedicated bundle as the responsible process for the desktop helpers.
let sources = [SIGTERM, SIGINT, SIGHUP].map { number in
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
    source.setEventHandler { if child.isRunning { kill(child.processIdentifier, number) } }
    source.resume()
    return source
}
withExtendedLifetime(sources) { child.waitUntilExit() }
exit(child.terminationStatus)
