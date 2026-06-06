import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Camera, CameraView }  from 'expo-camera';
import { useNavigation }       from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SafeAreaView }        from 'react-native-safe-area-context';
import { lookupBarcode }       from '../lib/openfoodfacts';
import { Colors, Spacing, Radius, Typography } from '../theme';
import { RootStackParamList }  from '../types';
import { todayKey }            from '../store/useStore';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Scanner'>;

export function ScannerScreen() {
  const navigation = useNavigation<Nav>();
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  useEffect(() => {
    Camera.requestCameraPermissionsAsync().then(({ status }) => {
      setHasPermission(status === 'granted');
    });
  }, []);

  const handleBarcode = async ({ data }: { data: string }) => {
    if (scanned || loading) return;
    setScanned(true);
    setLoading(true);
    setError('');
    try {
      const product = await lookupBarcode(data);
      if (product) {
        navigation.replace('Product', { product, date: todayKey(), mealType: 'breakfast' });
      } else {
        setError(`No product found for barcode ${data}. Try searching by name instead.`);
        setLoading(false);
      }
    } catch {
      setError('Lookup failed — check your connection.');
      setLoading(false);
    }
  };

  if (hasPermission === null) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centred}>
          <ActivityIndicator size="large" color={Colors.green} />
          <Text style={styles.msg}>Requesting camera permission…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centred}>
          <Text style={{ fontSize: 48 }}>📷</Text>
          <Text style={styles.msgBold}>Camera access denied</Text>
          <Text style={styles.msg}>Go to Android Settings → Apps → plated. → Permissions → Camera</Text>
          <TouchableOpacity style={styles.btn} onPress={() => navigation.goBack()}>
            <Text style={styles.btnText}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        onBarcodeScanned={scanned ? undefined : handleBarcode}
        barcodeScannerSettings={{ barcodeTypes: ['ean13','ean8','upc_a','upc_e','code128','code39','qr'] }}
      />
      <SafeAreaView style={styles.overlay}>
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.closeBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.closeTxt}>✕</Text>
          </TouchableOpacity>
          <Text style={styles.overlayTitle}>Scan barcode</Text>
          <View style={{ width: 44 }} />
        </View>
        <View style={styles.vfWrap}>
          <View style={styles.vf}>
            {(['tl','tr','bl','br'] as const).map((pos) => {
              const isTop = pos[0]==='t', isLeft = pos[1]==='l';
              return <View key={pos} style={[styles.corner, { top: isTop?-2:undefined, bottom: isTop?undefined:-2, left: isLeft?-2:undefined, right: isLeft?undefined:-2, borderTopWidth: isTop?3:0, borderBottomWidth: isTop?0:3, borderLeftWidth: isLeft?3:0, borderRightWidth: isLeft?0:3, borderTopLeftRadius: (isTop&&isLeft)?6:0, borderTopRightRadius: (isTop&&!isLeft)?6:0, borderBottomLeftRadius: (!isTop&&isLeft)?6:0, borderBottomRightRadius: (!isTop&&!isLeft)?6:0 }]} />;
            })}
          </View>
        </View>
        <View style={styles.bottom}>
          {loading ? (
            <View style={styles.statusCard}>
              <ActivityIndicator color={Colors.green} />
              <Text style={styles.statusText}>Looking up product…</Text>
            </View>
          ) : error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={() => { setScanned(false); setError(''); }}>
                <Text style={styles.retryText}>Try again</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => navigation.goBack()}>
                <Text style={styles.searchLink}>Search by name instead</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={styles.hint}>Point camera at the barcode on your food's packaging</Text>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: Colors.bg },
  overlay:      { flex: 1 },
  centred:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, gap: Spacing.md },
  msg:          { fontSize: Typography.sm, color: Colors.textMuted, textAlign: 'center', lineHeight: 20 },
  msgBold:      { fontSize: Typography.md, fontWeight: Typography.bold, color: Colors.text, textAlign: 'center' },
  btn:          { backgroundColor: Colors.surface, borderRadius: Radius.md, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm },
  btnText:      { color: Colors.text, fontWeight: Typography.semibold },
  topBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.md },
  closeBtn:     { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  closeTxt:     { color: '#fff', fontSize: Typography.base, fontWeight: Typography.bold },
  overlayTitle: { color: '#fff', fontSize: Typography.md, fontWeight: Typography.semibold },
  vfWrap:       { flex: 1, alignItems: 'center', justifyContent: 'center' },
  vf:           { width: 260, height: 160, position: 'relative' },
  corner:       { position: 'absolute', width: 28, height: 28, borderColor: Colors.green },
  bottom:       { padding: Spacing.lg, alignItems: 'center', minHeight: 140, justifyContent: 'center' },
  hint:         { color: 'rgba(255,255,255,0.6)', fontSize: Typography.sm, textAlign: 'center', lineHeight: 20 },
  statusCard:   { flexDirection: 'row', gap: Spacing.sm, backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center' },
  statusText:   { color: '#fff', fontSize: Typography.base },
  errorCard:    { backgroundColor: 'rgba(0,0,0,0.85)', borderRadius: Radius.lg, padding: Spacing.lg, alignItems: 'center', gap: Spacing.sm, width: '100%' },
  errorText:    { color: '#fff', fontSize: Typography.sm, textAlign: 'center', lineHeight: 20 },
  retryBtn:     { backgroundColor: Colors.green, borderRadius: Radius.full, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm },
  retryText:    { color: Colors.bg, fontWeight: Typography.bold, fontSize: Typography.base },
  searchLink:   { color: Colors.textMuted, fontSize: Typography.sm, paddingVertical: Spacing.xs },
});
