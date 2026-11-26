Pod::Spec.new do |s|
  s.name = 'CoveP2p'
  s.version = '0.1.0'
  s.summary = 'Encrypted Cove environment transport.'
  s.author = 'Cove Code'
  s.homepage = 'https://github.com/reonokiy/t3code'
  s.source = { :path => '.' }
  s.platform = :ios, '18.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.{swift,h}'
  s.frameworks = 'Security', 'SystemConfiguration'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.user_target_xcconfig = { 'OTHER_LDFLAGS' => '$(inherited) "$(BUILT_PRODUCTS_DIR)/libcove_p2p.a"' }
  s.script_phase = {
    :name => 'Build Cove Rust transport',
    :execution_position => :before_compile,
    :script => 'bash "$PODS_TARGET_SRCROOT/../build-native.sh" ios',
    :always_out_of_date => '1'
  }
end
