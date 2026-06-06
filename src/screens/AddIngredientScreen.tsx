import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp }          from '@react-navigation/native-stack';
import { SafeAreaView }                       from 'react-native-safe-area-context';
import { searchFood }                         from '../lib/openfoodfacts';
import { useStore }                           from '../store/useStore';
import { Colors, Spacing, Radius, Typography } from '../theme';
import { FoodProduct, RootStackParamList, SavedIngredient, MEAL_LABELS } from '../types';

type Nav   = NativeStackNavigationProp<RootStackParamList, 'AddIngredient'>;
type Route = RouteProp<RootStackParamList, 'AddIngredient'>;

type Tab = 'search' | 'library';

export function AddIngredientScreen() {
  const navigation             = useNavigation<Nav>();
  const { date, mealType }     = useRoute<Route>().params;
  const { savedIngredients, addEntry, saveIngredient } = useStore();

  const [tab,       setTab]       = useState<Tab>('search');
  const [query,     setQuery]     = useState('');
  const [results,   setResults]   = useState<FoodProduct[]>([]);
  const [searching, setSearching] = useState(false);

  // Manual form
  const [name,  setName]  = useState('');
  const [cals,  setCals]  = useState('');
  const [prot,  setProt]  = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat,   setFat]   = useState('');
  const [salt,  setSalt]  = useState('');
  const [fibre, setFibre] = useState('');
  const [sugar, setSugar] = useState('');
  const [saving, setSaving] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout>>();

  const handleSearch = (text: string) => {
    setQuery(text);
    clearTimeout(timer.current);
    if (text.trim().length < 2) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try { setResults(await searchFood(text.trim())); }
      catch { setResults([]); }
      finally { setSearching(false); }
    }, 600);
  };

  const handleSelectProduct = (product: FoodProduct) => {
    navigation.navigate('Product', { product, date, mealType });
  };

  // Quick-add from library — goes straight to ProductScreen with saved ingredient data
  const handleLibrarySelect = (saved: SavedIngredient) => {
    const product: FoodProduct = {
      name: saved.name, brand: saved.brand ?? '',
      cal_per100: saved.cal_per100, protein_per100: saved.protein_per100,
      carbs_per100: saved.carbs_per100, fat_per100: saved.fat_per100,
      salt_per100: saved.salt_per100, fibre_per100: saved.fibre_per100,
      sugar_per100: saved.sugar_per100, barcode: saved.barcode, off_id: saved.off_id,
    };
    navigation.navigate('Product', { product, date, mealType });
  };

  const handleManualAdd = async () => {
    if (!name.trim() || !cals) return;
    setSaving(true);
    await addEntry({
      date, meal_type: mealType,
      name: name.trim(), brand: '',
      serving_g: 100,
      calories: parseFloat(cals)  || 0,
      protein:  parseFloat(prot)  || 0,
      carbs:    parseFloat(carbs) || 0,
      fat:      parseFloat(fat)   || 0,
      salt:     parseFloat(salt)  || 0,
      fibre:    parseFloat(fibre) || 0,
      sugar:    parseFloat(sugar) || 0,
      source: 'manual',
    });
    setSaving(false);
    navigation.goBack();
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View>
            <Text style={styles.title}>Add ingredient</Text>
            <Text style={styles.subtitle}>{MEAL_LABELS[mealType]}</Text>
          </View>
          <TouchableOpacity style={styles.scanBtn} onPress={() => navigation.navigate('Scanner')}>
            <Text style={styles.scanText}>📷 Scan</Text>
          </TouchableOpacity>
        </View>

        {/* Tabs */}
        <View style={styles.tabs}>
          {(['search', 'library'] as Tab[]).map((t) => (
            <TouchableOpacity key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
              <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                {t === 'search' ? '🔍 Search' : `📚 My Library (${savedIngredients.length})`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {tab === 'search' && (
            <>
              <View style={styles.searchWrap}>
                <TextInput
                  style={styles.searchInput}
                  value={query}
                  onChangeText={handleSearch}
                  placeholder="Search food database…"
                  placeholderTextColor={Colors.textDim}
                  autoFocus
                />
                {searching && <ActivityIndicator size="small" color={Colors.green} style={{ marginLeft: 8 }} />}
              </View>

              {results.map((p, i) => (
                <TouchableOpacity key={i} style={styles.result} onPress={() => handleSelectProduct(p)} activeOpacity={0.7}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.resultName} numberOfLines={1}>{p.name}</Text>
                    {p.brand ? <Text style={styles.resultBrand}>{p.brand}</Text> : null}
                    <View style={styles.pillRow}>
                      {[`${p.cal_per100} kcal`, `P ${p.protein_per100}g`, `C ${p.carbs_per100}g`, `F ${p.fat_per100}g`].map((t) => (
                        <View key={t} style={styles.pill}><Text style={styles.pillText}>{t}</Text></View>
                      ))}
                      <Text style={styles.per100}>per 100g</Text>
                    </View>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              ))}

              {/* Divider + manual form */}
              <View style={styles.divider}>
                <View style={styles.divLine} /><Text style={styles.divText}>or enter manually</Text><View style={styles.divLine} />
              </View>
              <View style={styles.form}>
                <Field label="Ingredient name" value={name}  onChange={setName}  placeholder="e.g. Chicken breast" />
                <Field label="Calories (kcal)"  value={cals}  onChange={setCals}  placeholder="0" numeric />
                <View style={styles.twoCol}>
                  <View style={{ flex: 1 }}><Field label="Protein g"  value={prot}  onChange={setProt}  placeholder="0" numeric /></View>
                  <View style={{ flex: 1 }}><Field label="Carbs g"    value={carbs} onChange={setCarbs} placeholder="0" numeric /></View>
                </View>
                <View style={styles.twoCol}>
                  <View style={{ flex: 1 }}><Field label="Fat g"   value={fat}   onChange={setFat}   placeholder="0" numeric /></View>
                  <View style={{ flex: 1 }}><Field label="Salt g"  value={salt}  onChange={setSalt}  placeholder="0" numeric /></View>
                </View>
                <View style={styles.twoCol}>
                  <View style={{ flex: 1 }}><Field label="Fibre g" value={fibre} onChange={setFibre} placeholder="0" numeric /></View>
                  <View style={{ flex: 1 }}><Field label="Sugar g" value={sugar} onChange={setSugar} placeholder="0" numeric /></View>
                </View>
                <TouchableOpacity
                  style={[styles.addBtn, (!name.trim() || !cals) && { opacity: 0.4 }]}
                  onPress={handleManualAdd}
                  disabled={!name.trim() || !cals || saving}
                >
                  {saving ? <ActivityIndicator color={Colors.bg} /> : <Text style={styles.addBtnText}>Add to {MEAL_LABELS[mealType]}</Text>}
                </TouchableOpacity>
              </View>
            </>
          )}

          {tab === 'library' && (
            <View style={{ padding: Spacing.md }}>
              {savedIngredients.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyIcon}>📚</Text>
                  <Text style={styles.emptyTitle}>Library is empty</Text>
                  <Text style={styles.emptySub}>Ingredients you search or scan will be saved here for quick re-adding</Text>
                </View>
              ) : (
                savedIngredients.map((item) => (
                  <TouchableOpacity key={item.id} style={styles.result} onPress={() => handleLibrarySelect(item)} activeOpacity={0.7}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.resultName}>{item.name}</Text>
                      {item.brand ? <Text style={styles.resultBrand}>{item.brand}</Text> : null}
                      <View style={styles.pillRow}>
                        {[`${Math.round(item.cal_per100)} kcal`, `P ${item.protein_per100}g`, `C ${item.carbs_per100}g`, `F ${item.fat_per100}g`].map((t) => (
                          <View key={t} style={styles.pill}><Text style={styles.pillText}>{t}</Text></View>
                        ))}
                        <Text style={styles.per100}>per 100g · used {item.use_count}×</Text>
                      </View>
                    </View>
                    <Text style={styles.chevron}>›</Text>
                  </TouchableOpacity>
                ))
              )}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, value, onChange, placeholder, numeric }: { label: string; value: string; onChange: (t: string) => void; placeholder: string; numeric?: boolean }) {
  return (
    <View style={{ marginBottom: Spacing.sm }}>
      <Text style={{ fontSize: Typography.xs, fontWeight: Typography.semibold, color: Colors.textMuted, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</Text>
      <TextInput style={{ backgroundColor: Colors.surface2, borderRadius: Radius.sm, padding: Spacing.sm + 2, fontSize: Typography.base, color: Colors.text }} value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={Colors.textDim} keyboardType={numeric ? 'decimal-pad' : 'default'} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: Colors.bg },
  header:      { flexDirection: 'row', alignItems: 'center', padding: Spacing.md, paddingBottom: Spacing.sm, gap: Spacing.sm },
  backBtn:     { padding: Spacing.xs },
  backText:    { fontSize: 28, color: Colors.textMuted, lineHeight: 32 },
  title:       { fontSize: Typography.md, fontWeight: Typography.semibold, color: Colors.text },
  subtitle:    { fontSize: Typography.xs, color: Colors.green, fontWeight: Typography.medium },
  scanBtn:     { marginLeft: 'auto', backgroundColor: Colors.surface, borderRadius: Radius.full, paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs },
  scanText:    { fontSize: Typography.sm, color: Colors.text },
  tabs:        { flexDirection: 'row', margin: Spacing.md, marginTop: 0, backgroundColor: Colors.surface, borderRadius: Radius.full, padding: 4 },
  tab:         { flex: 1, paddingVertical: 8, borderRadius: Radius.full, alignItems: 'center' },
  tabActive:   { backgroundColor: Colors.green },
  tabText:     { fontSize: Typography.sm, color: Colors.textMuted, fontWeight: Typography.medium },
  tabTextActive:{ color: Colors.bg, fontWeight: Typography.bold },
  searchWrap:  { flexDirection: 'row', alignItems: 'center', marginHorizontal: Spacing.md, backgroundColor: Colors.surface, borderRadius: Radius.md, paddingHorizontal: Spacing.md, marginBottom: Spacing.sm },
  searchInput: { flex: 1, fontSize: Typography.base, color: Colors.text, paddingVertical: Spacing.md },
  result:      { backgroundColor: Colors.surface, borderRadius: Radius.md, padding: Spacing.md, marginHorizontal: Spacing.md, marginBottom: Spacing.sm, flexDirection: 'row', alignItems: 'center' },
  resultName:  { fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.text, marginBottom: 2 },
  resultBrand: { fontSize: Typography.xs, color: Colors.textMuted, marginBottom: 4 },
  pillRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignItems: 'center' },
  pill:        { backgroundColor: Colors.surface2, borderRadius: Radius.full, paddingHorizontal: 8, paddingVertical: 2 },
  pillText:    { fontSize: Typography.xs, color: Colors.textMuted },
  per100:      { fontSize: Typography.xs, color: Colors.textDim },
  chevron:     { fontSize: Typography.lg, color: Colors.textDim, paddingLeft: Spacing.sm },
  divider:     { flexDirection: 'row', alignItems: 'center', margin: Spacing.md, gap: Spacing.sm },
  divLine:     { flex: 1, height: 1, backgroundColor: Colors.border },
  divText:     { fontSize: Typography.xs, color: Colors.textMuted, fontWeight: Typography.medium },
  form:        { padding: Spacing.md, paddingTop: 0 },
  twoCol:      { flexDirection: 'row', gap: Spacing.sm },
  addBtn:      { backgroundColor: Colors.green, borderRadius: Radius.xl, paddingVertical: 14, alignItems: 'center', marginTop: Spacing.sm },
  addBtnText:  { fontSize: Typography.md, fontWeight: Typography.bold, color: Colors.bg },
  empty:       { alignItems: 'center', paddingVertical: Spacing.xl },
  emptyIcon:   { fontSize: 40, marginBottom: Spacing.sm },
  emptyTitle:  { fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.text, marginBottom: 4 },
  emptySub:    { fontSize: Typography.sm, color: Colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
