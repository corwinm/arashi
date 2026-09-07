// Dedicated real native child: no user applications or profile modifications.
use std::{env, fs, io::Write, time::Duration};
fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if let Ok(path) = env::var("ARASHI_LAUNCH_RECORD") {
        let mut record = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for arg in &args {
            record.write_all(arg.as_bytes()).unwrap();
            record.write_all(&[0]).unwrap();
        }
        record.write_all(&[0xff]).unwrap();
    }
    if let Ok(path) = env::var("ARASHI_LAUNCH_ENV_RECORD") {
        fs::write(
            path,
            format!(
                "{}\n{}\n{}",
                env::var("ARASHI_DIRECTIVE_FILE").unwrap_or_default(),
                env::var("ARASHI_SHELL").unwrap_or_default(),
                env::current_dir().unwrap().display()
            ),
        )
        .unwrap();
    }
    if let Ok(payload) = env::var("ARASHI_LAUNCH_STDOUT") {
        print!("{payload}");
    }
    if env::var("ARASHI_LAUNCH_MODE").as_deref() == Ok("wezterm")
        && args.first().is_some_and(|s| s == "cli")
    {
        std::process::exit(18);
    }
    if let Ok(delay) = env::var("ARASHI_LAUNCH_DELAY") {
        std::thread::sleep(Duration::from_millis(delay.parse().unwrap()));
    }
    if let Ok(path) = env::var("ARASHI_LAUNCH_FINISHED") {
        fs::write(path, "survived").unwrap();
    }
    std::process::exit(
        env::var("ARASHI_LAUNCH_EXIT")
            .ok()
            .map(|s| s.parse().unwrap())
            .unwrap_or(0),
    );
}
