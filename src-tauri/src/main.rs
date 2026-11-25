#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    velopack::VelopackApp::build()
        .set_app_user_model_id("com.alexmollard.axiom")
        .on_after_install_fast_callback(|_| {
            axiom_desktop_lib::register_protocol_handler();
        })
        .on_after_update_fast_callback(|_| {
            axiom_desktop_lib::register_protocol_handler();
        })
        .on_before_update_fast_callback(|_| {
            axiom_desktop_lib::stop_current_dir_node_backend();
        })
        .on_before_uninstall_fast_callback(|_| {
            axiom_desktop_lib::stop_current_dir_node_backend();
            axiom_desktop_lib::unregister_protocol_handler();
        })
        .run();
    axiom_desktop_lib::run();
}
