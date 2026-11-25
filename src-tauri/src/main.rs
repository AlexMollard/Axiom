#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    velopack::VelopackApp::build()
        .on_before_update_fast_callback(|_| {
            axiom_desktop_lib::stop_current_dir_node_backend();
        })
        .run();
    axiom_desktop_lib::run();
}
