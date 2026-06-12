import {
  IsBoolean, IsNumber, IsObject, IsOptional,
  IsString, Min, Max, IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AssetConfigDto {
  @IsString() ric: string;
  @IsString() name: string;
  @IsOptional() @IsNumber() profitRate?: number;
  @IsOptional() @IsString() typeName?: string;
  @IsOptional() @IsString() iconUrl?: string | null;
}

export class MartingaleDto {
  @IsBoolean() isEnabled: boolean;
  @IsNumber() @Min(1) @Max(10) maxSteps: number;
  @IsNumber() @Min(1) baseAmount: number;
  @IsNumber() @Min(0) multiplierValue: number;
  @IsIn(['FIXED', 'PERCENTAGE']) multiplierType: 'FIXED' | 'PERCENTAGE';
  @IsBoolean() isAlwaysSignal: boolean;
}

export class UpdateScheduleConfigDto {
  @IsObject() @Type(() => AssetConfigDto) asset: AssetConfigDto;
  @IsObject() @Type(() => MartingaleDto) martingale: MartingaleDto;
  @IsBoolean() isDemoAccount: boolean;
  @IsString() currency: string;
  @IsString() currencyIso: string;
  @IsOptional() @IsNumber() @Min(1) duration?: number;

  /**
   * Stop Loss: nilai kerugian total (satuan currency terkecil) yang memicu bot berhenti.
   * Set 0 untuk menonaktifkan.
   */
  @IsOptional() @IsNumber() @Min(0) stopLoss?: number;

  /**
   * Stop Profit: nilai keuntungan total yang memicu bot berhenti.
   * Set 0 untuk menonaktifkan.
   */
  @IsOptional() @IsNumber() @Min(0) stopProfit?: number;
}